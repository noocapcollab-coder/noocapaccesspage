// api/video.js
// Read-only single-video view for editors.
// Serves one card from a creator REELS board without exposing the rest of the
// workspace. Nothing here writes back to Notion.

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const headers = () => ({
  Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
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
    const pageRes = await fetch(`${NOTION}/pages/${id}`, { headers: headers() });
    if (pageRes.status === 404) {
      res.status(404).json({ error: 'not_found', message: 'No video matches this link.' });
      return;
    }
    if (!pageRes.ok) {
      const body = await pageRes.text();
      res.status(502).json({ error: 'notion_error', message: body.slice(0, 300) });
      return;
    }
    const page = await pageRes.json();
    const props = page.properties || {};

    const parent = page.parent || {};
    const parentId = bare(parent.data_source_id || parent.database_id || '');
    const creator = CREATOR_BY_ID[parentId] || '';

    let body = [];
    try {
      const blocksRes = await fetch(`${NOTION}/blocks/${id}/children?page_size=100`, { headers: headers() });
      if (blocksRes.ok) {
        const blocks = await blocksRes.json();
        body = renderBlocks(blocks.results);
      }
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
    };

    cache.set(id, { at: Date.now(), payload });
    res.status(200).json(payload);
  } catch (err) {
    res.status(500).json({ error: 'server_error', message: String(err && err.message ? err.message : err) });
  }
};
