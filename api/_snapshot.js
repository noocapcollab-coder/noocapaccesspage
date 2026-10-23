// Shared board snapshot from the PM (noocap-pm /api/boards). Every dashboard reads this one copy instead of asking
// Notion itself, so together they stay under Notion's rate limit. Needs BOARDS_KEY in this project's Vercel settings
// (same value as on noocap-pm). Without it, or if the snapshot can't be reached, callers fall back to Notion directly.
const SNAP_URL = 'https://noocap-pm.vercel.app/api/boards';
let snap = { t: 0, d: null }, snapP = null;
async function snapshot() {
  const k = process.env.BOARDS_KEY;
  if (!k) return null;
  if (snap.d && Date.now() - snap.t < 30000) return snap.d;
  if (!snapP) {
    snapP = fetch(SNAP_URL + '?k=' + encodeURIComponent(k), { signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.boards) snap = { t: Date.now(), d }; return snap.d; })
      .catch(() => snap.d)
      .finally(() => { snapP = null; });
  }
  return snapP;
}
// The board's rows in Notion's page shape, or null to mean "ask Notion yourself"
async function snapshotRows(ds) {
  const d = await snapshot();
  const b = d && d.boards && d.boards[String(ds || '').replace(/-/g, '').toLowerCase()];
  return b && !b.error ? b.rows : null;
}
// Find one card across all boards
async function snapshotPage(id) {
  const d = await snapshot();
  const want = String(id || '').replace(/-/g, '').toLowerCase();
  if (!d || !d.boards || !want) return null;
  for (const k in d.boards) for (const p of d.boards[k].rows || []) if (String(p.id).replace(/-/g, '') === want) return p;
  return null;
}
module.exports = { snapshotRows, snapshotPage };
