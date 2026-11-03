// api/video.js
// Read-only single-video view for editors.
// Serves one card from a creator REELS board without exposing the rest of the
// workspace. Nothing here writes back to Notion.

const { snapshotPage } = require('./_snapshot.js');
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Notion allows only a few requests a second per integration, and every NOOCAP tool shares this token.
// On "rate limited" or a Notion hiccup, wait what Notion asks and try again instead of failing the page.
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

// Creator lookup. Both source data source IDs and database IDs are listed so
// the parent resolves whichever shape the API returns.
const CREATOR_BY_ID = {
  // source data source IDs
  '28b508e99dda81ba8d7f000b84b83fbd': 'Brad',
  '2a1508e99dda8125bd63000bb75578dd': 'Chris',
  '301508e99dda811b83c7000b46be09b1': 'Lindsay',
  '328508e99dda8000b3c9000b0d791507': 'EmTech',
  '328508e99dda8186b4ca000bd212e84b': 'Duncan',
  f0dbec00505d4e168e51b2fcfea21445: 'Valeri',
  '36b508e99dda8004a37f000b460c8c46': 'Dmytro',
  '370508e99dda807b9554000ba747fde7': 'Jonathan',
  '340508e99dda80ae9625000b82f42207': 'Cindy',
  '305508e99dda81e6af3c000b968116a6': 'Joshua',
  // database IDs (fallback)
  '28b508e99dda81738029ce0e348a06be': 'Brad',
  '2a1508e99dda8079bfd2e252431e909a': 'Chris',
  '301508e99dda8023abcdfff22a175258': 'Lindsay',
  '328508e99dda809ca51cc70c5876ebc9': 'EmTech',
  '328508e99dda804aa43ed16e76a5bff3': 'Duncan',
  '34a508e99dda81d0a796e8fe8eaaa4c8': 'Valeri',
  '36b508e99dda8002a2f6f80361247c48': 'Dmytro',
  '361508e99dda80718f7ae9a2c32ec1db': 'Pipeline',
  '340508e99dda80f89ba5ca99bd68aa69': 'Cindy',
  '305508e99dda80e6afbae5075b2f3c45': 'Joshua',
};

const bare = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toLowerCase();

function dashed(id) {
  const b = bare(id);
  if (b.length !== 32) return null;
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20)}`;
}

function richText(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((t) => t.plain_text || '').join('');
}

// Flattens any Notion property into a plain string.
function plain(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': return richText(p.title);
    case 'rich_text': return richText(p.rich_text);
    case 'select': return p.select ? p.select.name : '';
    case 'status': return p.status ? p.status.name : '';
    case 'multi_select': return (p.multi_select || []).map((s) => s.name).join(', ');
    case 'people': return (p.people || []).map((x) => x.name).filter(Boolean).join(', ');
    case 'url': return p.url || '';
    case 'email': return p.email || '';
    case 'phone_number': return p.phone_number || '';
    case 'number': return p.number === null || p.number === undefined ? '' : String(p.number);
    case 'checkbox': return p.checkbox ? 'Yes' : '';
    case 'date': return p.date ? p.date.start || '' : '';
    case 'created_time': return p.created_time || '';
    case 'last_edited_time': return p.last_edited_time || '';
    case 'files':
      return (p.files || [])
        .map((f) => (f.file && f.file.url) || (f.external && f.external.url) || '')
        .filter(Boolean)
        .join(', ');
    case 'formula':
      if (!p.formula) return '';
      if (p.formula.type === 'string') return p.formula.string || '';
      if (p.formula.type === 'number') return p.formula.number === null ? '' : String(p.formula.number);
      if (p.formula.type === 'boolean') return p.formula.boolean ? 'Yes' : '';
      if (p.formula.type === 'date') return p.formula.date ? p.formula.date.start || '' : '';
      return '';
    default: return '';
  }
}

// Case-insensitive property lookup across a list of possible column names.
function pick(props, names) {
  const keys = Object.keys(props || {});
  for (const name of names) {
    const key = keys.find((k) => k.trim().toLowerCase() === name.trim().toLowerCase());
    if (key) {
      const v = plain(props[key]);
      if (v) return v;
    }
  }
  return '';
}

function titleOf(props) {
  for (const key of Object.keys(props || {})) {
    if (props[key] && props[key].type === 'title') {
      const t = richText(props[key].title);
      if (t) return t;
    }
  }
  return 'Untitled video';
}

// Page body, one level deep. Briefs often live below the properties.
function renderBlocks(results) {
  const out = [];
  for (const b of results || []) {
    const t = b.type;
    const node = b[t] || {};
    const text = richText(node.rich_text);
    if (t === 'paragraph' && text) out.push({ kind: 'p', text });
    else if (t === 'heading_1' && text) out.push({ kind: 'h', text });
    else if (t === 'heading_2' && text) out.push({ kind: 'h', text });
    else if (t === 'heading_3' && text) out.push({ kind: 'h', text });
    else if (t === 'bulleted_list_item' && text) out.push({ kind: 'li', text });
    else if (t === 'numbered_list_item' && text) out.push({ kind: 'li', text });
    else if (t === 'to_do') out.push({ kind: 'todo', text, done: !!node.checked });
    else if (t === 'quote' && text) out.push({ kind: 'quote', text });
    else if (t === 'callout' && text) out.push({ kind: 'quote', text });
    else if (t === 'toggle' && text) out.push({ kind: 'h', text });
    else if (t === 'code') out.push({ kind: 'code', text: richText(node.rich_text) });
    else if (t === 'divider') out.push({ kind: 'hr', text: '' });
    else if (t === 'image') {
      const url = (node.file && node.file.url) || (node.external && node.external.url) || '';
      if (url) out.push({ kind: 'img', text: url });
    } else if (t === 'video' || t === 'file' || t === 'pdf') {
      const url = (node.file && node.file.url) || (node.external && node.external.url) || '';
      if (url) out.push({ kind: 'file', text: url });
    } else if (t === 'bookmark' || t === 'embed' || t === 'link_preview') {
      if (node.url) out.push({ kind: 'file', text: node.url });
    }
  }
  return out;
}

// The script often lives in a sub-page of the card ("Script"), with the newest version on top (V3, then a V2 heading,
// then V1 in a toggle). Editors must see the approved one: a version marked approved/final if there is one, otherwise
// the highest version number, otherwise the whole page.
const VERSION_RE = /^\s*v(\d+)\b/i;
function blockText(b) { const n = b[b.type] || {}; return b.type === 'child_page' ? (n.title || '') : richText(n.rich_text); }
function pickApprovedVersion(blocks) {
  const segs = [];
  let cur = { v: null, label: '', blocks: [] };
  for (const b of blocks || []) {
    const text = blockText(b);
    const m = /^(heading_[123]|paragraph|toggle|callout)$/.test(b.type) ? text.match(VERSION_RE) : null;
    if (m) { segs.push(cur); cur = { v: Number(m[1]), label: text.split('\n')[0].trim(), blocks: [b] }; }
    else cur.blocks.push(b);
  }
  segs.push(cur);
  const versions = segs.filter((x) => x.v != null);
  if (!versions.length) return { label: '', blocks: blocks || [] };
  const chosen = versions.find((x) => /approved|final|locked/i.test(x.label)) || versions.reduce((a, b) => (b.v > a.v ? b : a));
  return { label: chosen.label, blocks: chosen.blocks };
}
async function pageBlocks(id, max = 300) {
  const all = [];
  let cursor = '';
  while (all.length < max) {
    const r = await nfetch(`${NOTION}/blocks/${id}/children?page_size=100${cursor ? '&start_cursor=' + cursor : ''}`, { headers: headers() });
    if (!r.ok) break;
    const j = await r.json();
    all.push(...(j.results || []));
    if (!j.has_more || !j.next_cursor) break;
    cursor = j.next_cursor;
  }
  return all;
}
// A toggle's own text is shown; open its inside too when it is the chosen version (V1 kept in a toggle)
async function withToggleKids(blocks) {
  const out = [];
  for (const b of blocks) {
    out.push(b);
    if (b.type === 'toggle' && b.has_children) out.push(...(await pageBlocks(b.id, 100).catch(() => [])));
  }
  return out;
}
async function scriptFrom(topBlocks) {
  const refs = (topBlocks || []).filter((b) => (b.type === 'child_page' && /script/i.test(b.child_page?.title || '')) || (b.type === 'link_to_page' && b.link_to_page?.page_id));
  for (const ref of refs.slice(0, 3)) {
    const pid = ref.type === 'child_page' ? ref.id : ref.link_to_page.page_id;
    if (ref.type === 'link_to_page') {
      const pr = await nfetch(`${NOTION}/pages/${pid}`, { headers: headers() });
      if (!pr.ok) continue;
      const pg = await pr.json();
      const t = Object.values(pg.properties || {}).find((x) => x.type === 'title');
      if (!/script/i.test(richText(t && t.title))) continue;
    }
    const chosen = pickApprovedVersion(await pageBlocks(pid));
    const rendered = renderBlocks(await withToggleKids(chosen.blocks));
    if (rendered.length) return { version: chosen.label.replace(/[:：]\s*$/, ''), blocks: rendered };
  }
  return null;
}

// Describes the token without revealing it, so a 401 can be diagnosed from the page.
function tokenHint() {
  const t = process.env.NOTION_TOKEN;
  if (t === undefined) return 'NOTION_TOKEN is not set on this deployment';
  if (t === '') return 'NOTION_TOKEN is set but empty';
  const trimmed = t.trim();
  const bits = [];
  bits.push('length ' + t.length);
  bits.push('starts with ' + JSON.stringify(t.slice(0, 4)));
  if (trimmed.length !== t.length) bits.push('HAS LEADING OR TRAILING WHITESPACE');
  if (/^["']|["']$/.test(trimmed)) bits.push('WRAPPED IN QUOTES');
  if (!/^(ntn_|secret_)/.test(trimmed)) bits.push('does not look like a Notion secret');
  return 'NOTION_TOKEN ' + bits.join(', ');
}

// Boards missing from the list above are named after their creator ("DASH - CHRIS", "NICOLE REELS"), so read the
// board's title once and match a known creator name in it.
const KNOWN_CREATORS = ['Brad', 'Chris', 'Lindsay', 'EmTech', 'Duncan', 'Valeri', 'Dmytro', 'Jonathan', 'Cindy', 'Joshua', 'David', 'Nicole'];
const boardNames = new Map(); // database id -> creator ('' when none matched)
async function creatorFromBoardName(parent) {
  const dbId = bare(parent.database_id || '');
  if (dbId.length !== 32) return '';
  if (boardNames.has(dbId)) return boardNames.get(dbId);
  const r = await nfetch(`${NOTION}/databases/${dashed(dbId)}`, { headers: headers() });
  let name = '';
  if (r.ok) {
    const db = await r.json();
    const title = richText(db.title).toLowerCase();
    name = KNOWN_CREATORS.find((c) => new RegExp('\\b' + c.toLowerCase()).test(title)) || '';
    if (!name && /valer/.test(title)) name = 'Valeri';
  }
  boardNames.set(dbId, name);
  return name;
}

const cache = new Map(); // id -> { at, payload }
const TTL = 20000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const id = dashed(req.query.id || '');
  if (!id) {
    res.status(400).json({ error: 'bad_id', message: 'Add ?id= with the Notion page ID.' });
    return;
  }

  const fresh = req.query.fresh === '1';
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL) {
    res.status(200).json(hit.payload);
    return;
  }

  try {
    // The card's fields come from the shared board snapshot when it has them, so a busy Notion can't block the page
    let page = fresh ? null : await snapshotPage(id).catch(() => null);
    if (!page) {
      const pageRes = await nfetch(`${NOTION}/pages/${id}`, { headers: headers() });
      if (pageRes.status === 404) {
        res.status(404).json({ error: 'not_found', message: 'No video matches this link.' });
        return;
      }
      if (!pageRes.ok) {
        const body = await pageRes.text();
        if (hit) { res.status(200).json(hit.payload); return; }
        if (pageRes.status === 429) { res.status(503).json({ error: 'busy', message: 'Notion is busy right now. Retrying in a few seconds.' }); return; }
        res.status(502).json({ error: 'notion_error', message: tokenHint() + ' || Notion said: ' + body.slice(0, 200) });
        return;
      }
      page = await pageRes.json();
    }
    const props = page.properties || {};

    const parent = page.parent || {};
    const parentId = bare(parent.data_source_id || parent.database_id || '');
    const creator = CREATOR_BY_ID[parentId] || (await creatorFromBoardName(parent).catch(() => ''));

    let body = [];
    let script = null;
    try {
      const top = await pageBlocks(id);
      body = renderBlocks(top);
      script = await scriptFrom(top).catch(() => null);
    } catch (e) {
      body = [];
    }

    const payload = {
      id: bare(id),
      title: titleOf(props),
      creator,
      status: pick(props, ['Status']),
      type: pick(props, ['TYPE', 'Type', 'Category']),
      editor: pick(props, ['Editor', 'Assigned Editor', 'Video Editor']),
      priority: pick(props, ['Priority']),
      effort: pick(props, ['Effort']),
      format: pick(props, ['Format']),
      postDate: pick(props, ['Post Date', 'POST DATE']),
      dueDate: pick(props, ['DUE DATE', 'Due Date', 'Deadline']),
      waitingOn: pick(props, ['Waiting On']),
      revisions: pick(props, ['Revisions']),
      assets: pick(props, ['Assets']),
      brief: pick(props, ['BRAND BRIEF', 'Brief', 'Script']),
      caption: pick(props, ['Caption']),
      notes: pick(props, ['Notes']),
      rawFootage: pick(props, ['Raw Footage', 'Footage']),
      asset: pick(props, ['Asset']),
      refVideo: pick(props, ['Ref Video', 'Reference', 'Reference Video']),
      editedVideo: pick(props, ['Edited Video', 'Final Video']),
      lastEdited: page.last_edited_time || '',
      body,
      script,
    };

    cache.set(id, { at: Date.now(), payload });
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message ? err.message : err) });
  }
};
