// api/track.js
// Edit tracking for the video brief page. The editor clicks a button, this stamps the time on that video's row in
// the EDIT TRACKER database (one row per video). Client REELS boards are never touched.
//
//   GET  /api/track?id=<video page id>          -> current tracking state for the page's buttons
//   POST /api/track  { id, action, title, creator, editor }
//        action: start_claude | start_manual | claude_done | send_review
//
// Needs the same NOTION_TOKEN as the rest of the page, and that integration connected to EDIT TRACKER
// (Notion -> EDIT TRACKER -> ... -> Connections). TRACKER_DB_ID can override the database below.

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TRACKER_DB = String(process.env.TRACKER_DB_ID || 'f18ddd9a6f874b62b2f50e768316fee1').replace(/-/g, '');

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

const ACTIONS = ['start_claude', 'start_manual', 'claude_done', 'send_review'];

function dateOf(p) { return p && p.date ? p.date.start || '' : ''; }
function selectOf(p) { return p && p.select ? p.select.name : ''; }
function rich(p) { return p && p.rich_text ? p.rich_text.map((t) => t.plain_text || '').join('') : ''; }

function stateOf(row) {
  if (!row) return { tracked: false };
  const p = row.properties || {};
  return {
    tracked: true,
    stage: selectOf(p['Stage']),
    mode: selectOf(p['Edit Mode']),
    editor: rich(p['Editor']),
    startedAt: dateOf(p['Started At']),
    claudeDoneAt: dateOf(p['Claude Done At']),
    sentAt: dateOf(p['Sent For Review At']),
    deliveredAt: dateOf(p['Delivered At']),
    revisions: p['Revisions'] ? p['Revisions'].number || 0 : 0,
  };
}

// Raises a readable error when the integration can't see the tracker, which is the one setup step people miss.
async function notionError(r) {
  const body = await r.text();
  if (r.status === 404 || r.status === 403) {
    const e = new Error('The NOTION_TOKEN integration cannot see EDIT TRACKER. In Notion open EDIT TRACKER, click ... then Connections, and add the same integration the boards use.');
    e.code = 'tracker_not_shared';
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

// What each button writes. "First" stamps are only set once so a double click or a revision round
// doesn't wipe the original start time.
function changesFor(action, row, now) {
  const s = stateOf(row);
  const props = {};
  const revisionRound = s.stage === 'Revision';

  if (action === 'start_claude' || action === 'start_manual') {
    const manual = action === 'start_manual';
    props['Edit Mode'] = { select: { name: manual ? 'Manual' : 'Claude' } };
    props['Stage'] = { select: { name: manual ? 'Manual editing' : 'Claude running' } };
    if (!s.startedAt) props['Started At'] = when(now);
    if (revisionRound) props['Revisions'] = { number: (s.revisions || 0) + 1 };
  } else if (action === 'claude_done') {
    props['Stage'] = { select: { name: 'Editor review' } };
    if (!s.claudeDoneAt) props['Claude Done At'] = when(now);
    if (!s.startedAt) props['Started At'] = when(now);
  } else if (action === 'send_review') {
    props['Stage'] = { select: { name: 'Ready for Harsh' } };
    props['Sent For Review At'] = when(now); // latest hand-off counts, so revision rounds show up
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
      res.status(200).json(stateOf(await findRow(id)));
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
    const props = changesFor(action, row, now);

    let saved;
    if (row) {
      if (b.editor && !stateOf(row).editor) props['Editor'] = { rich_text: text(b.editor) };
      const r = await nfetch(`${NOTION}/pages/${row.id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ properties: props }) });
      if (!r.ok) throw await notionError(r);
      saved = await r.json();
    } else {
      props['Video'] = { title: text(b.title || 'Untitled video') };
      props['Video ID'] = { rich_text: text(id) };
      props['Brief Link'] = { url: `https://${req.headers.host}/video.html?id=${id}` };
      props['Assigned Date'] = { date: { start: now.slice(0, 10) } };
      if (b.editor) props['Editor'] = { rich_text: text(b.editor) };
      if (b.creator) props['Creator'] = { select: { name: clip(b.creator, 90).replace(/,/g, ' ') } };
      const r = await nfetch(`${NOTION}/pages`, { method: 'POST', headers: headers(), body: JSON.stringify({ parent: { database_id: TRACKER_DB }, properties: props }) });
      if (!r.ok) throw await notionError(r);
      saved = await r.json();
    }

    res.status(200).json(stateOf(saved));
  } catch (err) {
    const code = err && err.code ? err.code : 'server_error';
    res.status(code === 'busy' ? 503 : 502).json({ error: code, message: String(err && err.message ? err.message : err) });
  }
};
