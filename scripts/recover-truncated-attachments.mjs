// scripts/recover-truncated-attachments.mjs — restore derived text that the OLD
// destructive clamps (6000/8000/600/4000 chars) cut off, by RE-DERIVING from the
// preserved raw bytes in blob-store. Non-destructive: it only ever REPLACES a
// truncated value with a LONGER full one (never shortens); the raw bytes are the
// source of truth and are untouched.
//
// What it recovers, per attachment kind:
//   text/document (pdf/docx/txt/md/…) → re-extract locally (NO model needed)   ← default
//   audio voice note                  → re-transcribe   (needs the audio service, --include-media)
//   image                             → re-caption       (needs the vision service, --include-media)
//
// DRY-RUN by default (reports what's recoverable). Pass --apply to write.
//
// Usage:
//   MYCELIUM_KEY_SOURCE=keychain MYCELIUM_DB="$HOME/Library/Application Support/id.mycelium.app/mycelium.db" \
//     node scripts/recover-truncated-attachments.mjs            # dry-run
//   …same… node scripts/recover-truncated-attachments.mjs --apply              # re-derive text/docs
//   …same… node scripts/recover-truncated-attachments.mjs --apply --include-media  # also voice/images (services must be up)
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { resolveKeys } from '../src/crypto/key-source.js';
import { getBlob } from '../src/ingest/blob-store.js';
import { extractDocumentText, documentKindOf } from '../src/enrich/extract-document.js';
import { transcribeAudio } from '../src/enrich/transcribe-audio.js';
import { describeImage } from '../src/enrich/describe-image.js';
import { clampStored } from '../src/enrich/text-limits.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB;
const APPLY = process.argv.includes('--apply');
const INCLUDE_MEDIA = process.argv.includes('--include-media');
if (!DB_PATH) { console.error('Set MYCELIUM_DB to the target vault db.'); process.exit(1); }

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|toml|csv))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|json|xml|ya?ml|toml|log|ini|conf)$/i;
const NUL = /\x00/g;
// The OLD clamps. Marker = doc/text (visible). The others were SILENT — detect by
// exact at-cap length (a value sitting precisely on an old boundary is a strong
// truncation signal; re-derivation is idempotent so a false positive just re-stores
// the same text, never harms).
const MARKER = '[… truncated]';
const OLD_CAPS = new Set([6000, 8000, 4000, 600]);

function kindOf(row) {
  const ft = String(row.file_type || ''), fn = String(row.file_name || '');
  if (ft.startsWith('image/')) return 'image';
  if (ft.startsWith('audio/')) return 'audio';
  if (TEXT_MIME.test(ft) || TEXT_EXT.test(fn)) return 'text';
  if (documentKindOf(ft, fn)) return 'document';
  return 'other';
}
// the derived-text field each kind writes
const fieldOf = (k) => (k === 'audio' ? 'transcript' : 'description');
function isTruncated(val) {
  if (typeof val !== 'string' || !val) return false;
  return val.includes(MARKER) || OLD_CAPS.has(val.length);
}

async function run() {
  const { userHex, systemHex } = resolveKeys();
  const userKey = await loadKey(userHex);
  const systemKey = await loadKey(systemHex);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });

  console.log(`\n=== recover truncated attachments ${APPLY ? '(APPLY)' : '(DRY RUN)'}${INCLUDE_MEDIA ? ' +media' : ''} ===`);
  console.log(`  DB:   ${DB_PATH}\n  user: ${USER_ID}\n`);

  const rows = await db.attachments.listByUser(USER_ID, { limit: 100000, offset: 0 });
  const hits = [];
  for (const r of rows) {
    const k = kindOf(r);
    const field = fieldOf(k);
    if (isTruncated(r[field]) && r.local_path) hits.push({ id: r.id, kind: k, field, name: r.file_name || '', len: (r[field] || '').length, local_path: r.local_path, file_type: r.file_type });
  }

  if (!hits.length) { console.log('  No truncated attachments with recoverable bytes found.'); close(); console.log('\nVERDICT: GO — nothing to recover.'); return; }

  const byKind = hits.reduce((a, h) => ((a[h.kind] = (a[h.kind] || 0) + 1), a), {});
  console.log(`  truncated attachments with raw bytes: ${hits.length}  ${JSON.stringify(byKind)}`);
  for (const h of hits.slice(0, 12)) console.log(`    [${h.kind}] ${h.name || h.id.slice(0, 8)} — stored ${h.len} chars (${h.field})`);
  if (hits.length > 12) console.log(`    … and ${hits.length - 12} more`);

  if (!APPLY) {
    const modelFree = hits.filter((h) => h.kind === 'text' || h.kind === 'document').length;
    const media = hits.length - modelFree;
    console.log(`\n  recoverable now (text/docs, no model): ${modelFree}`);
    console.log(`  needs audio/vision service (--include-media): ${media}`);
    close();
    console.log('\n(dry run — nothing written. Re-run with --apply to re-derive full text.)');
    console.log(`VERDICT: REVIEW — ${hits.length} attachments would be recovered.`);
    return;
  }

  let recovered = 0, grew = 0, skipped = 0, failed = 0;
  for (const h of hits) {
    try {
      const bytes = await getBlob(h.local_path);
      let full = null;
      if (h.kind === 'text') full = clampStored(bytes.toString('utf8').replace(NUL, '').trim());
      else if (h.kind === 'document') full = await extractDocumentText({ bytes, mimeType: h.file_type, fileName: h.name });
      else if (INCLUDE_MEDIA && h.kind === 'audio') full = await transcribeAudio({ bytes, mimeType: h.file_type, fileName: h.name });
      else if (INCLUDE_MEDIA && h.kind === 'image') full = await describeImage({ bytes });
      else { skipped++; continue; } // media without --include-media

      if (!full) { failed++; continue; } // extraction/service unavailable → leave as-is
      if (full.length <= h.len) { recovered++; continue; } // already full (idempotent), or service returned shorter — never shorten
      await db.attachments.update(h.id, { [h.field]: full });
      recovered++; grew++;
      console.log(`    ✓ [${h.kind}] ${h.name || h.id.slice(0, 8)}: ${h.len} → ${full.length} chars`);
    } catch (e) { failed++; console.error(`    ✗ ${h.id.slice(0, 8)}: ${e.message}`); }
  }

  close();
  console.log(`\n  recovered: ${recovered}  (grew: ${grew})   skipped(media, no flag): ${skipped}   failed/unavailable: ${failed}`);
  console.log('  NOTE: this restores attachments.{description,transcript}. The Library document copy + the original');
  console.log('  channel message re-sync on next enrichment / re-extract; the canonical derived text is now full.');
  console.log(`VERDICT: ${grew > 0 ? 'GO' : 'REVIEW'} — ${grew} attachments restored to full text.`);
}

run().catch((e) => { console.error('recover failed:', e.message); process.exit(1); });
