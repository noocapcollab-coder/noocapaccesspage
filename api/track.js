// api/track.js
// Edit tracking for the video brief page, all in one Notion database: EDIT TRACKER (one row per video).
// The editor's buttons stamp the times; "Send for review" also fills in the hand-off details (creator, editor,
// format, type, Frame.io link) and sets Status to In Review, which is what the n8n review flow watches.
// Client REELS boards are never touched.
//
//   GET  /api/track?id=<video page id>   -> current state for the page's buttons
//   POST /api/track  { id, action, title, creator, editor, handoff? }
//        action: start_claude | start_manual | claude_done | send_review
//        handoff (first send only): { frameio, creator, editor, contentType, type }
//
// Status flow: Claude running / Manual editing -> Editor review -> In Review -> Changes (back to editor)
//              -> To Post -> Posted
// Needs the same NOTION_TOKEN as the rest of the page, with that integration connected to EDIT TRACKER.
// TRACKER_DB_ID can override the database below.

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TRACKER_DB = String(process.env.TRACKER_DB_ID || 'f18ddd9a6f874b62b2f50e768316fee1').replace(/-/g, '');

// EDIT TRACKER's dropdown values. Creator and Editor match the old Video Intake form so n8n reads the same names.
const CREATORS = ['Duncan', 'Brad', 'Lindsay', 'Chris', 'EmTech', 'Valerie', 'David', 'Nicole', 'Dmytro', 'Jonathan', 'Cindy', 'Joshua'];
const EDITORS = ['Parvez', 'Sumith', 'Utsav', 'Vicky', 'Prabal', 'Abhishek', 'PRATEEK'];
const CONTENT_TYPES = ['SHORT-FORM', 'LONG-FORM'];
const TYPES = ['PERSONAL', 'SPONSOR'];
const ACTIONS = ['start_claude', 'start_manual', 'claude_done', 'send_review'];
const NOTE_HOOK = process.env.EDIT_NOTE_WEBHOOK || 'https://n8n-production-cd10f.up.railway.app/webhook/noocap-edit-note';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function nfetch(url, opts) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, opts);
    if ((r.status !== 429 && r.status < 500) || attempt >= 4) return r;
    const ra = parseFloat(r.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(ra) ? ra * 1000 : 700 * Math.pow(2, attempt), 6000) + Math.random() * 300);
  }
}

const headers = () => ({
  Authorization: `Bearer ${String(process.env.NOTION_TOKEN || '').trim().replace(/^["']|["']$/g, '')}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
});

const bare = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
const clip = (s, n) => String(s || '').trim().slice(0, n);
const text = (s) => [{ type: 'text', text: { content: clip(s, 1900) } }];
const when = (iso) => ({ date: { start: iso } });
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ''));

function dateOf(p) { return p && p.date ? p.date.start || '' : ''; }
function selectOf(p) { return p && p.select ? p.select.name : ''; }

// Case-insensitive match against a dropdown's options, with the spelling differences between boards.
function matchOption(value, options) {
  const alias = { valeri: 'valerie' };
  let v = String(value || '').trim().toLowerCase();
  v = alias[v] || v;
  return options.find((o) => o.toLowerCase() === v) || '';
}

function stateOf(row) {
  if (!row) return { tracked: false };
  const p = row.properties || {};
  return {
    tracked: true,
    status: selectOf(p['Status']),
    mode: selectOf(p['Edit Mode']),
    editor: selectOf(p['Editor']),
    creator: selectOf(p['Creator']),
    startedAt: dateOf(p['Started At']),
    claudeDoneAt: dateOf(p['Claude Done At']),
    sentAt: dateOf(p['Sent For Review At']),
    draftSubmittedAt: dateOf(p['Draft Submitted At']),
    approvedAt: dateOf(p['Approved At']),
    revisions: p['Revisions'] ? p['Revisions'].number || 0 : 0,
    frameio: p['Frame.io Link'] ? p['Frame.io Link'].url || '' : '',
  };
}

const reply = (row) => ({ ...stateOf(row), options: { creators: CREATORS, editors: EDITORS } });

// Raises a readable error when the integration can't see the tracker, which is the one setup step people miss.
async function notionError(r) {
  const body = await r.text();
  if (r.status === 404 || r.status === 403) {
    const e = new Error('The NOTION_TOKEN integration cannot see EDIT TRACKER. In Notion open EDIT TRACKER, click ... then Connections, and add the same integration the boards use.');
    e.code = 'not_shared';
    return e;
  }
  const e = new Error('Notion said: ' + body.slice(0, 200));
  e.code = r.status === 429 ? 'busy' : 'notion_error';
  return e;
}

async function findRow(videoId) {
  const r = await nfetch(`${NOTION}/databases/${TRACKER_DB}/query`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      filter: { property: 'Video ID', rich_text: { equals: videoId } },
      sorts: [{ timestamp: 'created_time', direction: 'descending' }],
      page_size: 1,
    }),
  });
  if (!r.ok) throw await notionError(r);
  const j = await r.json();
  return (j.results && j.results[0]) || null;
}

async function patchRow(rowId, props) {
  const r = await nfetch(`${NOTION}/pages/${rowId}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ properties: props }) });
  if (!r.ok) throw await notionError(r);
  return r.json();
}

// Checks a first hand-off's details before anything is written, so a half-filled hand-off never reaches review.
function cleanHandoff(h) {
  h = h || {};
  const out = {
    frameio: clip(h.frameio, 1900),
    creator: matchOption(h.creator, CREATORS),
    editor: matchOption(h.editor, EDITORS),
    contentType: matchOption(h.contentType, CONTENT_TYPES),
    type: matchOption(h.type, TYPES),
  };
  const missing = [];
  if (!isUrl(out.frameio)) missing.push('the Frame.io link');
  if (!out.creator) missing.push('the creator');
  if (!out.editor) missing.push('your name');
  if (!out.contentType) missing.push('short or long form');
  if (!out.type) missing.push('personal or sponsor');
  return { handoff: out, missing };
}

// What each button writes. "First" stamps are only set once so a double click or a revision round
// doesn't wipe the original times.
function changesFor(action, row, now) {
  const s = stateOf(row);
  const props = {};

  if (action === 'start_claude' || action === 'start_manual') {
    const manual = action === 'start_manual';
    props['Edit Mode'] = { select: { name: manual ? 'Manual' : 'Claude' } };
    props['Status'] = { select: { name: manual ? 'Manual editing' : 'Claude running' } };
    if (!s.startedAt) props['Started At'] = when(now);
    if (s.status === 'Changes') props['Revisions'] = { number: (s.revisions || 0) + 1 };
  } else if (action === 'claude_done') {
    props['Status'] = { select: { name: 'Editor review' } };
    if (!s.claudeDoneAt) props['Claude Done At'] = when(now);
    if (!s.startedAt) props['Started At'] = when(now);
  } else if (action === 'send_review') {
    props['Status'] = { select: { name: 'In Review' } };
    props['Sent For Review At'] = when(now); // latest hand-off, so every round shows up
    if (!s.draftSubmittedAt) props['Draft Submitted At'] = when(now);
    else props['Changes Done At'] = when(now);
    if (!s.startedAt) props['Started At'] = when(now);
  }
  return props;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const id = bare(req.query.id);
      if (id.length !== 32) { res.status(400).json({ error: 'bad_id' }); return; }
      let row = await findRow(id);
      // Approval happens in review (n8n or by hand). Stamp when it first shows up, if nobody else did.
      const s = stateOf(row);
      if (row && (s.status === 'To Post' || s.status === 'Posted') && !s.approvedAt) {
        row = await patchRow(row.id, { 'Approved At': when(new Date().toISOString()) }).catch(() => row);
      }
      res.status(200).json(reply(row));
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

    const b = await readBody(req);
    const id = bare(b.id);
    const action = String(b.action || '');
    if (id.length !== 32) { res.status(400).json({ error: 'bad_id' }); return; }
    if (ACTIONS.indexOf(action) === -1) { res.status(400).json({ error: 'bad_action' }); return; }

    const now = new Date().toISOString();
    const row = await findRow(id);
    const s = stateOf(row);
    const props = changesFor(action, row, now);

    // The first send carries the hand-off details; a revision round already has them.
    if (action === 'send_review') {
      const { handoff, missing } = cleanHandoff(b.handoff);
      if (!s.draftSubmittedAt && missing.length) {
        res.status(400).json({ error: 'handoff_incomplete', message: 'Add ' + missing.join(', ') + ' before sending.' });
        return;
      }
      if (isUrl(handoff.frameio)) props['Frame.io Link'] = { url: handoff.frameio };
      if (handoff.creator) props['Creator'] = { select: { name: handoff.creator } };
      if (handoff.editor) props['Editor'] = { select: { name: handoff.editor } };
      if (handoff.contentType) props['CONTENT TYPE'] = { select: { name: handoff.contentType } };
      if (handoff.type) props['TYPE'] = { select: { name: handoff.type } };
    }

    // Fill creator and editor from the brief when the row doesn't have them yet.
    const editor = matchOption(b.editor, EDITORS);
    const creator = matchOption(b.creator, CREATORS);
    if (!props['Editor'] && editor && !s.editor) props['Editor'] = { select: { name: editor } };
    if (!props['Creator'] && creator && !s.creator) props['Creator'] = { select: { name: creator } };

    let saved;
    if (row) {
      saved = await patchRow(row.id, props);
    } else {
      props['Video Title'] = { title: text(b.title || 'Untitled video') };
      props['Video ID'] = { rich_text: text(id) };
      props['Brief Link'] = { url: `https://${req.headers.host}/video.html?id=${id}` };
      props['Assigned Date'] = { date: { start: now.slice(0, 10) } };
      const r = await nfetch(`${NOTION}/pages`, { method: 'POST', headers: headers(), body: JSON.stringify({ parent: { database_id: TRACKER_DB }, properties: props }) });
      if (!r.ok) throw await notionError(r);
      saved = await r.json();
    }

    // Tell the video's Discord thread (started, render done, sent for review). n8n builds the line from the row
    // itself; a slow or failed note never blocks the editor's button.
    await fetch(NOTE_HOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: saved.id, action }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});

    res.status(200).json(reply(saved));
  } catch (err) {
    const code = err && err.code ? err.code : 'server_error';
    res.status(code === 'busy' ? 503 : 502).json({ error: code, message: String(err && err.message ? err.message : err) });
  }
};
