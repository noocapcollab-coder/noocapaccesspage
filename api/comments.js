// api/comments.js — read-only Notion page comments for the video brief page.
// Requires the integration to have "Read comments" turned on in Notion
// (Settings → Connections → your integration → Capabilities), and
// "Read user information" if you want real author names instead of "NOOCAP".

const NOTION = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
const TTL = 30000;

const cache = new Map();      // pageId -> { at, payload }
const userCache = new Map();  // userId -> display name

function idOf(raw) {
  const hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 32 ? hex : '';
}

async function notion(path, token) {
  const r = await fetch(NOTION + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': VERSION
    }
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

async function nameFor(userId, token) {
  if (!userId) return 'NOOCAP';
  if (userCache.has(userId)) return userCache.get(userId);
  const res = await notion('/users/' + userId, token);
  let name = 'NOOCAP';
  if (res.ok && res.json) {
    name = res.json.name || (res.json.bot && res.json.bot.workspace_name) || 'NOOCAP';
  }
  userCache.set(userId, name);
  return name;
}

function mapRich(rt) {
  return (rt || []).map(function (t) {
    const a = t.annotations || {};
    return {
      t: t.plain_text || '',
      b: !!a.bold,
      i: !!a.italic,
      u: !!a.underline,
      s: !!a.strikethrough,
      c: !!a.code,
      hl: a.color && a.color !== 'default' ? String(a.color) : '',
      href: t.href || ''
    };
  }).filter(function (p) { return p.t !== ''; });
}

module.exports = async function handler(req, res) {
  const token = process.env.NOTION_TOKEN;
  const pageId = idOf(req.query && req.query.id);

  res.setHeader('Cache-Control', 'no-store');

  if (!token) return res.status(500).json({ error: 'no_token' });
  if (!pageId) return res.status(400).json({ error: 'bad_id' });

  const fresh = req.query && req.query.fresh === '1';
  const hit = cache.get(pageId);
  if (!fresh && hit && Date.now() - hit.at < TTL) {
    return res.status(200).json(hit.payload);
  }

  try {
    const out = [];
    let cursor = '';
    for (let guard = 0; guard < 5; guard++) {
      const q = '/comments?block_id=' + pageId + '&page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
      const r = await notion(q, token);

      if (!r.ok) {
        if (r.status === 403) return res.status(403).json({ error: 'no_comment_access' });
        if (r.status === 404) return res.status(404).json({ error: 'not_found' });
        return res.status(502).json({
          error: 'notion_error',
          message: (r.json && r.json.message) || r.text.slice(0, 200)
        });
      }

      (r.json.results || []).forEach(function (c) { out.push(c); });
      if (!r.json.has_more) break;
      cursor = r.json.next_cursor;
    }

    // Author names, one lookup per distinct user.
    const ids = [];
    out.forEach(function (c) {
      const uid = c.created_by && c.created_by.id;
      if (uid && ids.indexOf(uid) === -1) ids.push(uid);
    });
    const names = {};
    for (const uid of ids) names[uid] = await nameFor(uid, token);

    // Group into threads so replies sit under the comment they answer.
    const order = [];
    const byDiscussion = {};
    out.forEach(function (c) {
      const d = c.discussion_id || c.id;
      if (!byDiscussion[d]) { byDiscussion[d] = []; order.push(d); }
      byDiscussion[d].push({
        id: c.id,
        author: names[c.created_by && c.created_by.id] || 'NOOCAP',
        createdTime: c.created_time || '',
        rich: mapRich(c.rich_text)
      });
    });

    const threads = order.map(function (d) {
      return { discussion: d, comments: byDiscussion[d] };
    });

    const payload = { count: out.length, threads: threads };
    cache.set(pageId, { at: Date.now(), payload: payload });
    return res.status(200).json(payload);

  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err && err.message ? err.message : err) });
  }
};
