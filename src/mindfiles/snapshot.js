/**
 * Shared pre-mutation snapshot primitive for mind files.
 *
 * Extracted so BOTH write paths — the agent tool layer (src/tools/internal.js)
 * and the operator character-page REST layer (src/portal-character.js) — capture
 * history identically: first-write-wins per UTC day per filename. An operator
 * edit and revert must land in the same dated snapshot trail as an agent rewrite,
 * so "see what changed" / revert (design §5.6) work regardless of who wrote.
 *
 * Semantics (unchanged from the original internal.js copy): if today's snapshot
 * already exists (any content), it is a no-op that preserves the pre-cycle
 * anchor. Returns { ok, path, idempotent? } or { ok:false, error:'source-not-found' }.
 */
export async function captureSnapshot({ readMindFile, writeMindFile }, filename, opts = {}) {
  const today = opts.today || new Date().toISOString().split('T')[0];
  const snapshotRelPath = `snapshots/${filename}/${today}.md`;
  const existing = await readMindFile(snapshotRelPath);
  if (existing != null) {
    return { ok: true, path: snapshotRelPath, idempotent: true };
  }
  const source = await readMindFile(filename);
  if (source == null) {
    return { ok: false, error: 'source-not-found' };
  }
  await writeMindFile(snapshotRelPath, source);
  return { ok: true, path: snapshotRelPath };
}
