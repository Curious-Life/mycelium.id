// verify:import-consent — D-070 / D-069. The import surface must honour, and must not
// overstate, what the user agreed to.
//
// OPERATOR'S REPORT (QA9 cold-run on shipped v0.1.13), verbatim:
//   "Mac section: deselected Photos/Videos/Audio, left only Documents (~9.7K docs vs ~9K
//    photos/videos/audio). Clicked Import → it imported the TOTAL of all categories anyway."
//   and, of onboarding step 4: "Mycelium reads these files on your device to build your map.
//    Nothing leaves your machine." — false the moment a cloud model is configured.
//
// For a cognitive vault, importing data the user withheld consent for is a privacy breach,
// and an absolute privacy claim a supported configuration breaks is a lie. Both are gated
// here, end to end: the click, the wire, the route, the disk, and the rendered sentence.
//
// ── The checks ────────────────────────────────────────────────────────────────────────────
//  U1  UI — the operator's exact gesture (keep Documents, drop Photos/Video/Audio) puts
//      EXACTLY {categories:['document']} on the wire. Driven on the REAL mounted component.
//  U2  UI — switching EVERY category off sends NOTHING and the Import button is disabled.
//      Fail-closed at the first surface.
//  U3  UI (control) — an untouched row sends all four. Proves U1/U2 are not passing because
//      the component never posts at all.
//  U4  UI — the progress denominator counts the SELECTION, not the all-category total. A
//      documents-only run that reports "of ~18,700" is the operator's symptom even when the
//      importer behaved; a progress bar denominated by refused data is a lie about scope.
//  U5  UI — a sweep that was ALREADY running when the component mounted is ADOPTED: its
//      progress and a Cancel button appear. Without this the 409 above is a dead end — a
//      page reload loses `busy`, so the user is told "cancel it first" with nothing to cancel.
//  W1  WIRE — startLocalSweep([]) sends {categories: []}, never {}. The pre-fix
//      `categories?.length ? {categories} : {}` is the line that turned "none of it" into
//      "no opinion", which the server answered with "then take everything".
//  S1  IMPORTER — categories:['document'] over a mixed folder enrols ONLY documents: zero
//      image/audio/video attachments AND zero image/voice/video memories.
//  S2  IMPORTER — categories:[] imports NOTHING (not everything).
//  S3  IMPORTER — an OMITTED selection throws `bad_request`. There is no default-all.
//  S4  IMPORTER — a selection of only-unknown keys imports nothing (unknown never widens).
//  S5  IMPORTER — the count the UI ADVERTISES and the count the importer ENROLS agree. The
//      detector counted at maxDepth 5 while the importer walked maxDepth 8, so a
//      documents-only run enrolled MORE documents than its own chip promised (measured
//      pre-fix: chip 7, enrolled 9) — which, denominated against the all-category total,
//      is indistinguishable from "it imported everything". This is the second half of the
//      operator's report, and it is a real defect even though no media was ever imported.
//  S-CTRL  IMPORTER — all four categories DOES bring the media in. Without this, every
//      "zero media" assertion above would also pass on a fixture with no media in it.
//  R1  ROUTE (real HTTP, real disk) — POST {categories:['document']} leaves the vault with
//      documents only and zero media attachments. The headline: the operator's gesture,
//      end to end.
//  R2  ROUTE — POST with NO categories → 400, and nothing is imported.
//  R3  ROUTE — POST {categories:[]} → 400.
//  R4  ROUTE — POST {categories:['bogus']} → 400 (an unrecognised selection is not consent).
//  R5  ROUTE — re-attach cannot launder a different consent: while a ['document'] sweep is
//      running, POST {categories:['image']} → 409, and the running job keeps its own
//      selection. The pre-fix route returned ok:true + the old job's progress, so the UI
//      reported success while the sweep carried on with categories the user had switched off.
//  R6  ROUTE — progress echoes the ENFORCED selection, so the client can state what was
//      allowed in rather than what it hoped it asked for.
//  R7  ROUTE — EVERY malformed-body shape answers with a terse JSON 4xx, not body-parser's
//      HTML page carrying a stack and absolute server paths (CLAUDE.md §1). Four shapes:
//      bad JSON, bad charset, bad content-encoding, and a gzip header over a plain body.
//      The first version of this check sent only the first and printed GREEN over the
//      other three (independent review) — the reason the handler is now default-deny on
//      status rather than an enumeration of `err.type`.
//  U6  UI — an ADOPTED job (one already running at mount) is described by the SERVER's own
//      record of it, never by this row's chips: its scope, its denominator, no onImported,
//      and no terminal "✓ Done". The first fix routed it through runSweep, so a foreign
//      documents-only job rendered "of ~18,700" and an all-four job under documents-only
//      chips ended as a bare "Imported 9698 items ✓ Done" — telling a user who deselected
//      Photos that their import succeeded while photos were ingested. That is the reported
//      defect again, as a UI-reporting bug (round-2 review, CRITICAL 1).
//  C3  COPY — the same claim family over the POST-SCAN branch (chips + Import button), the
//      one where consent is actually given. C1's mount only reaches the idle branch.
//  C-CTRL2  COPY — the claim family FIRES: it matches every phrasing round 2 proved was a
//      miss, and none of the accurate copy. Without this, an elaborate regex with a typo
//      would make every "no claim found" above free.
//  C1  COPY — NO absolute "nothing/never leaves" claim renders on the step — matched as a
//      FAMILY, over the step mounted WITH its real ScanForData child. Both halves are the
//      review's finding: the first version matched one literal and stubbed out the very
//      component that was still making the claim, one word away ("device", not "machine").
//  C2  COPY — the operator's approved replacement is PRESENT, verbatim.
//  C-CTRL  COPY — a sentinel string is absent from the same rendered text, so C1 is a real
//      observation and not a harness that sees nothing.
//
// ── MUTATION RECORD (/gate-teeth: a gate is not evidence until you have watched it fail) ──
// Every mutation below was APPLIED to the real product file, the gate re-run and its output
// read, the file restored from a `cp` snapshot, and the tree re-run GREEN. The observed
// results are transcribed as observed — including the ones that came out weaker than
// expected, which is the whole point of running them.
//
// MUTATION-TESTED: [M1] src/ingest/local-files-import.js — the consent gate reverted to the exact pre-fix line
//   `const wanted = new Set(Array.isArray(categories) && categories.length ?
//   categories.filter((c) => allCats.includes(c)) : allCats)`, early-return removed.
//   → S2 RED  {"scanned":5,"docsDelta":2,"attsDelta":3} on the second run (see M3) — an empty
//     selection imported the whole mixed folder, photos and audio and video included.
//   → S3 RED  the omitted selection returned a summary instead of throwing.
//   → S4 stayed GREEN, and NOT by accident: the pre-fix expression only widens when
//     `categories.length` is 0, so `['bogus']` filtered to `[]` and imported nothing anyway.
//     S4's teeth are for a *different* future regression (a filter that passes unknown keys
//     through), and this is recorded rather than dressed up.
//   → S1 stayed GREEN. Honest and important: the ['document'] path was never the broken one.
//     That is exactly why this fail-open survived review — the case anyone would test by hand
//     worked, and only the *empty* and *missing* cases widened.
//   → R2/R3/R4 stayed GREEN in this run, because the route's own gate rejects first.
// MUTATION-TESTED: [M2] src/portal-import.js — the route's consent gate deleted and
//   `const categories = Array.isArray(req.body?.categories) ? req.body.categories : undefined`
//   restored, together with the unconditional re-attach.
//   → R2 RED (status 200 for a request carrying no consent), R3 RED (200 for `[]`),
//     R4 RED (200 for `['bogus']`), R5 RED {"conflictStatus":200} — the conflicting
//     ['image'] POST was accepted while the ['document'] job ran on, which is the
//     "reported success, kept importing what you switched off" fail-open.
//   → the DATA halves of R2/R3/R4 stayed at delta 0, because with only this layer mutated the
//     importer's own gate still threw. Defence in depth doing its job — and a reminder that
//     R2's "nothing imported" clause is only load-bearing when BOTH layers are broken (M3).
//   → R6 stayed GREEN: the mutation left `sweepMeta.categories` assigned.
// MUTATION-TESTED: [M3] BOTH of the above at once — i.e. the actual shipped pre-fix product.
//   → R2 RED with the consent violation reproduced end to end through the REAL HTTP surface:
//     {"status":200,"docsDelta":602,"mediaDelta":4} — a request that carried NO consent at all
//     imported every photo, voice memo and video in the fixture home.
//   → R3/R4 RED on status only (their deltas were 0 because R2's sweep had already ingested
//     the same files and the second run deduped) and R1 RED as a knock-on for the same reason.
//   → S2 RED {"scanned":5,"docsDelta":2,"attsDelta":3}, S3 RED.
// MUTATION-TESTED: [M4] portal-app/src/lib/import/detect.ts — `{ categories: categories ?? [] }` reverted to
//   `categories?.length ? { categories } : {}`.
//   → W1 RED (the empty selection went on the wire as `{}`). Every other check stayed GREEN:
//     the UI never *reaches* that call with an empty selection because of the two component
//     guards, so W1 is the only check with teeth for this layer — which is why it exists.
// MUTATION-TESTED: [M5] ScanForData.svelte — `disabled={… || nothingSelected(s) || …}` reverted to the pre-fix
//   predicate (button guard only).
//   → U2 RED {"disabled":false,"posts":[]} — RED on the disabled assertion alone; the
//     `runImport` early-return still blocked the request. Recorded as observed.
// MUTATION-TESTED: [M5b] …and the `runImport` early-return removed as well (both component guards gone).
//   → U2 RED {"disabled":false,"posts":[{"body":{"categories":[]}}]} — the empty selection
//     now reaches the wire, which is the state M4 shows the server must catch.
// MUTATION-TESTED: [M6] ScanForData.svelte — sweepDenom reverted to `Math.max(s.count || 0, sweep.total || 0)`.
//   → U4 RED: the documents-only run rendered "Importing… 0 of ~18,700" — the operator's
//     exact symptom, on a run that was importing documents only.
// MUTATION-TESTED: [M7] ScanForData.svelte — the category toggle's onclick inverted to `cats[key] !== false`,
//   so a click can never switch a category OFF (the "the deselection never took" hypothesis).
//   → U1 RED (all four categories sent after deselecting three), U2 RED, U4 RED
//     ("of ~18,700"). This mutation reproduces the operator's report verbatim and is the
//     regression guard for it.
// MUTATION-TESTED: [M8] ImportStep.svelte — the consent line restored to "Mycelium reads these files on your
//   device to build your map — nothing leaves your machine."
//   → C1 RED and C2 RED.
// MUTATION-TESTED: [M10] ScanForData.svelte — the `void adoptRunningSweep()` call removed from
//   scan(), i.e. a sweep already running at mount is no longer picked up.
//   → U5 RED {"adoptCancel":false,"controlCancel":false} — no Cancel button for a job the user
//     cannot otherwise stop, which is what turns the new 409 into a dead end.
// MUTATION-TESTED: [M11] portal-app/src/lib/components/import/ScanForData.svelte — the scan
//   sub-label's "— nothing leaves your device." clause restored (the claim an INDEPENDENT
//   ADVERSARIAL REVIEW found still rendering on this screen while the first version of this
//   gate printed GREEN, because it stubbed ScanForData out and matched only the word
//   "machine").
//   → C1 RED with {"childMounted":true,"matched":"nothing leaves"} — i.e. RED with the real
//     child mounted, which is the proof the blindness is gone rather than papered over.
// MUTATION-TESTED: [M12] src/portal-import.js — the body-parser error handler removed.
//   → R7 RED {"status":400,"leaks":true,...} with the response body being body-parser's HTML
//     page: `<pre>SyntaxError: Unexpected token 'n', "not jso…`.
// MUTATION-TESTED: [M13] src/ingest/detect-sources.js — `countByCategory`'s maxDepth
//   re-localised to its own pre-fix `5` instead of the shared SWEEP_MAX_DEPTH.
//   → S5 RED {"detectorCounted":5,"importerEnrolled":7} — the count the user consents to
//     understating the set that actually lands, which is the second half of the operator's
//     report and the reason a documents-only run could read as "everything".
// MUTATION-TESTED: [M9] control — proving the copy harness can see ABSENCE, not an empty string:
//   the consent <p> deleted outright → C2 RED while C1 and C-CTRL stayed GREEN.
//
// ── Round-2 review remediation (it returned BLOCK) — the checks it forced ──────────────────
// MUTATION-TESTED: [M14] ScanForData.svelte — the adopt routed back through runSweep (the
//   round-1 shape), so an adopted job's labels come from THIS row's chips again.
//   → U6 RED with the review's CRITICAL 1 reproduced verbatim: {"problems":["denominator
//     borrowed the chips' all-category total","chips scope hint rendered beside a foreign
//     job","adopted job does not state its own scope","adopted job does not use its own
//     total"]}, rendered as "Will import 18,700 files · documents, photos, video and audio
//     Importing… 120 of ~18,700 (1%)" — for a server job importing DOCUMENTS ONLY.
//   Observed honestly: U6's terminal-Done and onImported clauses did NOT red in this run,
//   because the harness settles before the stubbed job reaches a terminal status. They are
//   regression guards for the end-of-run half of the same defect; they are not what red here.
// MUTATION-TESTED: [M15] ScanForData.svelte — "your files never leave your Mac" added to the
//   scan sub-label: the PLURAL-VERB phrasing round 2 proved the previous family missed.
//   → C1 RED, matched "never leave". Under the pre-round-2 regex this phrasing was GREEN.
// MUTATION-TESTED: [M16] ScanForData.svelte — "nothing leaves your device" injected into the
//   POST-SCAN branch, which C1's harness structurally cannot reach (its api stub returns no
//   sources, so only the idle branch renders).
//   → C3 RED on all four runs {"runsRenderingTheChips":4,"of":4,"hits":[× "nothing leaves"]}
//     while C1 stayed GREEN — which is why C3 exists, and it is the check with teeth for the
//     branch where consent is actually given.
// MUTATION-TESTED: [M17] this gate — the optional plural removed from the "never leaves?" arm.
//   → C-CTRL2 RED {"missed":["Your files never leave your Mac.","Your thoughts never leave
//     this device."]}. The control that stops an elaborate regex from silently matching
//     nothing and making every "no claim found" above free.
// MUTATION-TESTED: [M18] src/portal-import.js — the body-parser handler reverted from
//   default-deny-on-status to the two-err.type enumeration.
//   → R7 RED on THREE of its four shapes, each returning body-parser's HTML page: bogus
//     charset (415) and bogus content-encoding (415) both "<pre>UnsupportedMedia…", and
//     gzip-header-over-plain-body (400) "<pre>Error: incorrect header check". The
//     malformed-JSON shape stayed GREEN — i.e. the original single-shape check passed over
//     all three leaks, which is the review's MAJOR 3.
//
// ⚠️ ONE VACUITY FOUND AND FIXED WHILE MUTATING THIS GATE, recorded so it is not re-introduced:
// R2/R3/R4 originally read the document/attachment counts immediately after the POST. The
// sweep is a DETACHED job, so those counts were 0 whatever the route decided — the "nothing
// imported" clause was decoration and only the status code had teeth. They now `await
// settle()` first, which is what let M3 observe the 602-document / 4-media leak.
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. Front end: mount the real components and read the real payloads ────────────────────
function runMount(script) {
  const out = execFileSync(process.execPath, ['--conditions', 'browser', `test/${script}`], {
    cwd: path.join(REPO, 'portal-app'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf('{')));
}

let scan = { mounted: false, runs: {}, wire: [] };
let copy = { mounted: false, text: '' };
try { scan = runMount('mount-scan-categories.mjs'); } catch (e) { console.log(`      mount-scan-categories failed: ${String(e?.message || e).slice(0, 400)}`); }
try { copy = runMount('mount-import-consent-copy.mjs'); } catch (e) { console.log(`      mount-import-consent-copy failed: ${String(e?.message || e).slice(0, 400)}`); }

{
  const r = scan.runs?.documentsOnly;
  rec('U1 UI — deselecting Photos/Video/Audio sends EXACTLY {categories:["document"]}',
    !!scan.mounted && r?.posts?.length === 1 && r.posts[0].path === '/portal/import/local-files' && eq(r.posts[0].body, { categories: ['document'] }),
    JSON.stringify({ mounted: scan.mounted, error: scan.error, posts: r?.posts, chipsOn: r?.on }));
}
{
  const r = scan.runs?.noneSelected;
  rec('U2 UI — every category off ⇒ Import DISABLED and nothing is sent (fail-closed)',
    !!scan.mounted && r?.disabledBefore === true && (r?.posts?.length ?? -1) === 0,
    JSON.stringify({ disabled: r?.disabledBefore, posts: r?.posts, chipsOn: r?.on }));
}
{
  const r = scan.runs?.untouched;
  rec('U3 UI (control) — an untouched row DOES post, with all four categories',
    !!scan.mounted && r?.posts?.length === 1 && eq([...(r.posts[0].body.categories ?? [])].sort(), ['audio', 'document', 'image', 'video']),
    JSON.stringify({ posts: r?.posts }));
}
{
  const t = scan.runs?.documentsOnly?.text || '';
  rec('U4 UI — the progress denominator counts the SELECTION (~9,700), not the total (~18,700)',
    t.includes('of ~9,700') && !t.includes('of ~18,700') && t.includes('Will import 9,700 files'),
    JSON.stringify({ text: t.slice(0, 260) }));
}
{
  const r = scan.runs?.adopt;
  rec('U5 UI — a sweep already running at mount is ADOPTED (progress + Cancel), so the 409 is never a dead end',
    !!scan.mounted && r?.cancelAfterScan === true && scan.runs?.untouched?.cancelAfterScan === false,
    JSON.stringify({ adoptCancel: r?.cancelAfterScan, controlCancel: scan.runs?.untouched?.cancelAfterScan, text: (r?.text || '').slice(0, 200) }));
}
{
  const a = scan.runs?.adopt;
  const t = a?.text || '';
  const problems = [];
  // The chips' all-category total must NOT be the denominator, and the chips' scope must not
  // be presented as what is running. Both were true of the first fix.
  if (/of ~18,700/.test(t)) problems.push('denominator borrowed the chips\' all-category total');
  if (/Will import 18,700/.test(t)) problems.push('chips scope hint rendered beside a foreign job');
  // It must name the ADOPTED job's own consent, from the server's echoed categories.
  if (!/still running — documents only/.test(t)) problems.push('adopted job does not state its own scope');
  if (!/of ~9,700/.test(t)) problems.push('adopted job does not use its own total');
  // Not the user's import: no completion signal, no terminal Done.
  if ((a?.importedFired ?? -1) !== 0) problems.push(`onImported fired ${a?.importedFired} time(s) for a job the user did not start`);
  if (/✓ Done/.test(t)) problems.push('a terminal "Done" was left for a job the user did not start');
  if (a?.actionLabel !== 'Cancel') problems.push(`row action is "${a?.actionLabel}", expected Cancel`);
  rec('U6 UI — an ADOPTED job is described by the SERVER\'s record of it, never by this row\'s chips',
    !!scan.mounted && problems.length === 0, JSON.stringify({ problems, text: t.slice(0, 320) }));
}
{
  const empty = (scan.wire || [])[0];
  const one = (scan.wire || [])[1];
  rec('W1 WIRE — startLocalSweep([]) sends {categories: []}, never {} (no "no opinion" body)',
    eq(empty?.body, { categories: [] }) && eq(one?.body, { categories: ['document'] }),
    JSON.stringify(scan.wire));
}

// ── 2. Importer + route: real boot, real disk, real HTTP ──────────────────────────────────
const DB = 'data/verify-import-consent.db';
const KCV = 'data/verify-import-consent-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
mkdirSync('data', { recursive: true });

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const M4A = Buffer.from([0, 0, 0, 32, 1, 2, 3, 4]);
const MP4 = Buffer.from([0, 0, 0, 24, 9, 9, 9, 9]);

/** A folder with one of each category (+ a second doc), so "zero media" is falsifiable. */
function mixedFolder(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'idea.md'), '# Idea\nA note the user DID consent to.');
  writeFileSync(path.join(dir, 'log.txt'), 'plain text log entry');
  writeFileSync(path.join(dir, 'photo.png'), PNG);
  writeFileSync(path.join(dir, 'memo.m4a'), M4A);
  writeFileSync(path.join(dir, 'clip.mp4'), MP4);
  return dir;
}

const { applyMigrations } = await import('../src/db/migrate.js');
const { boot } = await import('../src/index.js');
const { importLocalFiles } = await import('../src/ingest/local-files-import.js');
const { ALL_FILE_CATEGORIES } = await import('../src/ingest/file-categories.js');
const { countByCategory } = await import('../src/ingest/detect-sources.js');

{ const seed = new Database(DB); applyMigrations(seed); seed.close(); }
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'verify-import-consent-user';
const raw = new Database(DB, { readonly: true });
// The media surfaces a deselected category would land on: an encrypted attachment row AND a
// linked memory. Checking only one would miss half a leak.
const mediaAttachments = () => raw.prepare("SELECT COUNT(*) c FROM attachments WHERE file_type LIKE 'image/%' OR file_type LIKE 'audio/%' OR file_type LIKE 'video/%'").get().c;
const mediaMemories = () => raw.prepare("SELECT COUNT(*) c FROM messages WHERE message_type IN ('image','voice','video')").get().c;
const docCount = () => raw.prepare('SELECT COUNT(*) c FROM documents').get().c;
const attCount = () => raw.prepare('SELECT COUNT(*) c FROM attachments').get().c;

const tmpRoot = path.join(os.tmpdir(), `consent-${process.pid}`);
try { rmSync(tmpRoot, { recursive: true }); } catch { /* */ }

// S1 — the consented category only.
{
  const dir = mixedFolder(path.join(tmpRoot, 's1'));
  const before = { att: attCount(), mem: mediaMemories() };
  const s = await importLocalFiles(db, { userId, folderPath: dir, categories: ['document'] });
  rec('S1 IMPORTER — categories:["document"] enrols ONLY documents (0 media rows, 0 media memories)',
    s.documents.created === 2 && s.attachments.imported === 0 && mediaAttachments() === before.att && mediaMemories() === before.mem && s.scanned === 2,
    JSON.stringify({ scanned: s.scanned, docs: s.documents, atts: s.attachments, mediaAtt: mediaAttachments(), mediaMem: mediaMemories() }));
}
// S5 — the count the UI advertises and the count the importer enrols must not diverge.
//   This is the OTHER half of the operator's report. The detector counts at maxDepth 5
//   (detect-sources.js countByCategory) while the importer walks maxDepth 8 (walkFiles), so a
//   documents-only run could enrol MORE documents than its own chip advertised — which, against
//   an all-category denominator, is indistinguishable from "it imported everything". Measured
//   on the pre-fix tree: chip said 7, the importer enrolled 9, and the bar read "9 of ~11".
{
  const dir = path.join(tmpRoot, 's5');
  mkdirSync(dir, { recursive: true });
  let deep = dir;
  for (let i = 1; i <= 7; i++) { deep = path.join(deep, `d${i}`); mkdirSync(deep, { recursive: true }); writeFileSync(path.join(deep, `deep${i}.md`), `# depth ${i}\nx`); }
  const counted = countByCategory(dir); // the SAME function the detector's chips come from
  const s = await importLocalFiles(db, { userId, folderPath: dir, categories: ['document'] });
  rec('S5 IMPORTER — the advertised document count and the enrolled count agree (same walk depth)',
    (counted.document?.count ?? 0) === s.documents.created,
    JSON.stringify({ detectorCounted: counted.document?.count ?? 0, importerEnrolled: s.documents.created, scanned: s.scanned }));
}

// S2 — an EMPTY selection imports nothing.
{
  const dir = mixedFolder(path.join(tmpRoot, 's2'));
  const before = { docs: docCount(), atts: attCount() };
  const s = await importLocalFiles(db, { userId, folderPath: dir, categories: [] });
  rec('S2 IMPORTER — categories:[] imports NOTHING (an empty selection is not "everything")',
    s.scanned === 0 && s.documents.created === 0 && s.attachments.imported === 0 && docCount() === before.docs && attCount() === before.atts,
    JSON.stringify({ scanned: s.scanned, docsDelta: docCount() - before.docs, attsDelta: attCount() - before.atts }));
}
// S3 — an OMITTED selection is a caller bug, not a yes.
{
  const dir = mixedFolder(path.join(tmpRoot, 's3'));
  const before = { docs: docCount(), atts: attCount() };
  let threw = null;
  try { await importLocalFiles(db, { userId, folderPath: dir }); } catch (e) { threw = e; }
  rec('S3 IMPORTER — an OMITTED selection THROWS bad_request (there is no default-all)',
    !!threw && threw.code === 'bad_request' && docCount() === before.docs && attCount() === before.atts,
    JSON.stringify({ code: threw?.code, msg: String(threw?.message || '').slice(0, 120), docsDelta: docCount() - before.docs }));
}
// S4 — unknown keys never widen.
{
  const dir = mixedFolder(path.join(tmpRoot, 's4'));
  const before = { docs: docCount(), atts: attCount() };
  const s = await importLocalFiles(db, { userId, folderPath: dir, categories: ['bogus', 'DOCUMENT ', 42, null] });
  rec('S4 IMPORTER — an unrecognised selection imports nothing (unknown never widens to all)',
    s.scanned === 0 && docCount() === before.docs && attCount() === before.atts,
    JSON.stringify({ scanned: s.scanned, enforced: s.categories, docsDelta: docCount() - before.docs }));
}
// S-CTRL — the fixture really does contain media, and it really can land.
{
  const dir = mixedFolder(path.join(tmpRoot, 'sctrl'));
  const beforeMedia = mediaAttachments();
  const s = await importLocalFiles(db, { userId, folderPath: dir, categories: [...ALL_FILE_CATEGORIES] });
  rec('S-CTRL IMPORTER (control) — all four categories DOES bring the media in (so "zero media" above is real)',
    s.attachments.imported === 3 && mediaAttachments() === beforeMedia + 3 && s.scanned === 5,
    JSON.stringify({ scanned: s.scanned, atts: s.attachments.imported, mediaDelta: mediaAttachments() - beforeMedia }));
}

// ── 3. The route, over real HTTP, against a real sweep home ───────────────────────────────
const HOME = path.join(tmpRoot, 'home');
for (const d of ['Documents', 'Desktop', 'Downloads', 'Music', 'Pictures', 'Movies']) mkdirSync(path.join(HOME, d), { recursive: true });
writeFileSync(path.join(HOME, 'Documents', 'journal.md'), '# Journal\nSomething the user consented to.');
writeFileSync(path.join(HOME, 'Documents', 'notes.txt'), 'more consented text');
writeFileSync(path.join(HOME, 'Pictures', 'holiday.png'), PNG);
writeFileSync(path.join(HOME, 'Pictures', 'portrait.jpg'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
writeFileSync(path.join(HOME, 'Music', 'voice-memo.m4a'), M4A);
writeFileSync(path.join(HOME, 'Movies', 'birthday.mp4'), MP4);
// R5 needs the sweep to still be running when the conflicting POST lands — give the
// ['document'] selection enough real work (encrypt + write) that it cannot finish inside one
// loopback round-trip.
for (let i = 0; i < 600; i++) writeFileSync(path.join(HOME, 'Desktop', `bulk-${i}.md`), `# bulk ${i}\n${'x'.repeat(400)}\n`);

process.env.HOME = HOME; // os.homedir() reads $HOME on POSIX → localSweepRoots resolves here
const { portalImportRouter } = await import('../src/portal-import.js');
const app = express();
app.use('/', portalImportRouter({ db, userId, enqueueEnrichment: () => {} }));
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const settle = async () => { for (let i = 0; i < 900; i++) { const p = await get('/import/local-files/progress'); if (p.body.status !== 'running') return p.body; await new Promise((r) => setTimeout(r, 50)); } return null; };

// R2/R3/R4 first — they must not import anything, so run them before any legitimate sweep.
{
  const before = { docs: docCount(), media: mediaAttachments() };
  const r = await post('/import/local-files', { });
  // Settle FIRST. The job is detached, so reading the counts straight after the POST would
  // find 0/0 no matter what the route decided — the "nothing imported" clause would be
  // vacuous and only the status code would have teeth (caught while mutation-testing this
  // very gate). settle() returns immediately when nothing is running.
  await settle();
  const after = { docs: docCount(), media: mediaAttachments() };
  rec('R2 ROUTE — POST with NO categories → 400, and NOTHING is imported',
    r.status === 400 && after.docs === before.docs && after.media === before.media,
    JSON.stringify({ status: r.status, body: r.body, docsDelta: after.docs - before.docs, mediaDelta: after.media - before.media }));
}
{
  const before = { media: mediaAttachments(), docs: docCount() };
  const r = await post('/import/local-files', { categories: [] });
  await settle();
  rec('R3 ROUTE — POST {categories: []} → 400 (an empty selection is refused, never widened)',
    r.status === 400 && mediaAttachments() === before.media && docCount() === before.docs, JSON.stringify({ status: r.status, body: r.body, mediaDelta: mediaAttachments() - before.media, docsDelta: docCount() - before.docs }));
}
{
  const before = { media: mediaAttachments(), docs: docCount() };
  const r = await post('/import/local-files', { categories: ['bogus'] });
  await settle();
  rec('R4 ROUTE — POST {categories: ["bogus"]} → 400 (unrecognised is not consent)',
    r.status === 400 && mediaAttachments() === before.media && docCount() === before.docs, JSON.stringify({ status: r.status, body: r.body, mediaDelta: mediaAttachments() - before.media, docsDelta: docCount() - before.docs }));
}

// R1 + R5 + R6 — the operator's gesture, end to end, with a conflicting re-click mid-flight.
{
  const before = { docs: docCount(), media: mediaAttachments(), mem: mediaMemories() };
  const start = await post('/import/local-files', { categories: ['document'] });
  const running = await get('/import/local-files/progress');
  const conflict = await post('/import/local-files', { categories: ['image'] });
  const stillDocs = (await get('/import/local-files/progress')).body?.categories;
  // ⚠️ SCOPE OF R5, so nobody over-trusts it (independent review, MINOR 3): the `categories`
  // it reads back come from the SAME module variable the 409 compares against, so R5 proves
  // the running job's consent was not overwritten — it is not an independent observation of
  // disk. The disk property for this window is carried by R1's mediaAttDelta === 0 below,
  // whose measurement window spans the conflicting POST.
  rec('R5 ROUTE — a re-click with a DIFFERENT selection is REFUSED (409), the running job keeps its own consent',
    running.body.status === 'running' && conflict.status === 409 && eq(stillDocs, ['document']),
    JSON.stringify({ runningStatus: running.body.status, conflictStatus: conflict.status, conflictBody: conflict.body?.error, enforced: stillDocs }));

  const same = await post('/import/local-files', { categories: ['document'] });
  rec('R5b ROUTE — a re-click with the SAME selection still re-attaches (idempotent, not broken)',
    same.status === 200, JSON.stringify({ status: same.status }));

  const done = await settle();
  const after = { docs: docCount(), media: mediaAttachments(), mem: mediaMemories() };
  rec('R1 ROUTE — the operator\'s gesture end-to-end: documents land, ZERO photos/audio/video do',
    start.status === 200 && !!done && done.status === 'done' && after.docs > before.docs
      && after.media === before.media && after.mem === before.mem,
    JSON.stringify({ start: start.status, done: done?.status, docsDelta: after.docs - before.docs, mediaAttDelta: after.media - before.media, mediaMemDelta: after.mem - before.mem }));
  rec('R6 ROUTE — progress echoes the ENFORCED selection, so the client can state what was allowed in',
    eq(done?.categories, ['document']), JSON.stringify({ categories: done?.categories }));
}

// R7 — a malformed body must not answer with a stack trace.
{
  // FOUR shapes, not one. The first version of this check sent only the malformed-JSON case
  // and printed GREEN while the three sibling body-parser failures still returned an HTML
  // page with a stack and absolute install paths (independent review).
  const shapes = [
    ['malformed JSON', { 'content-type': 'application/json' }, 'not json at all'],
    ['bogus charset', { 'content-type': 'application/json; charset=utf-99' }, '{}'],
    ['bogus content-encoding', { 'content-type': 'application/json', 'content-encoding': 'br-bogus' }, '{}'],
    ['gzip header, plain body', { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'not gzipped at all'],
  ];
  const leaked = [];
  for (const [label, headers, body] of shapes) {
    const bad = await fetch(base + '/import/local-files', { method: 'POST', headers, body });
    const text = await bad.text();
    // A stack, an HTML error page, or an absolute path from this machine.
    const leaks = /<pre>|<html|Error:.*\n?\s*at |\/Users\/|node:internal/.test(text);
    const terse = /^\{"ok":false,"error":"[^"]{1,80}"\}$/.test(text.trim());
    if (leaks || !terse || bad.status < 400 || bad.status >= 500) leaked.push({ label, status: bad.status, leaks, terse, body: text.slice(0, 120) });
  }
  rec('R7 ROUTE — EVERY malformed-body shape → a terse JSON 4xx: no stack, no HTML page, no server paths',
    leaked.length === 0, JSON.stringify({ probed: shapes.length, offending: leaked }));
}

// ── 4. The copy ───────────────────────────────────────────────────────────────────────────
// A FAMILY, not one literal, and not one grammatical form.
//   Round 1: this gate matched only "nothing leaves your machine", and a review found
//   ScanForData's sub-label still saying "nothing leaves your DEVICE" — one word away, green.
//   Round 2: the family itself was one letter from a miss. `never leaves` requires the
//   singular verb, so "your files never LEAVE your Mac" slipped through, as did the
//   "stays on"/"never sent"/"never uploaded"/"100% local" phrasings of the same promise.
// An absolute privacy claim is a SHAPE. Match the shape, in every voice it can be written in.
// The bounded `[^.!?]{0,N}` gaps let a subject sit between the noun and the verb
// ("Nothing about your files leaves this Mac") without spanning sentence boundaries.
const DECEPTIVE = new RegExp([
  String.raw`\b(nothing|no data|no file|not a byte|none of (it|this|your data))\b[^.!?]{0,40}?\b(ever\s+)?leaves?\b`,
  String.raw`\bnever\s+leaves?\b`,
  String.raw`\bdoes(n't|\s+not)\s+leave\b`,
  String.raw`\bstays?\b[^.!?]{0,20}?\b(on (your|this)|local)\b`,
  String.raw`\bnever\s+(sent|uploaded|transmitted|shared)\b`,
  String.raw`\bnothing\b[^.!?]{0,30}?\bever\s+(uploaded|sent|transmitted)\b`,
  String.raw`\b(100%|fully|entirely|completely)\s+(local|private|on-device)\b`,
].join('|'), 'i');
const APPROVED = 'Mycelium reads these files and stores them on your device to build your map.';
const SENTINEL = 'this sentence is never rendered anywhere in the onboarding import step';
{
  const t = copy.text || '';
  const hit = t.match(DECEPTIVE);
  rec('C1 COPY — NO absolute "nothing/never leaves" claim renders anywhere on the step (incl. the real ScanForData child)',
    !!copy.mounted && copy.childMounted === true && !hit,
    JSON.stringify({ mounted: copy.mounted, childMounted: copy.childMounted, error: copy.error, matched: hit?.[0] ?? null, text: t.slice(0, 300) }));
  rec('C2 COPY — the operator\'s approved replacement is PRESENT, verbatim',
    !!copy.mounted && t.includes(APPROVED), JSON.stringify({ text: t.slice(0, 300) }));
  rec('C-CTRL COPY (control) — the harness can see ABSENCE (a sentinel is not found in the same text)',
    !!copy.mounted && t.length > 40 && !t.includes(SENTINEL), JSON.stringify({ len: t.length }));
}
// C3 — the copy mount only ever renders ScanForData's `idle` branch (its api stub returns no
// sources, so Scan yields nothing). The branch where consent is actually GIVEN — the chips,
// the scope hint, the Import button — is the `done` branch, and C1 was blind to it: a claim
// injected there passed with childMounted:true and matched:null (round-2 review). The scan
// mount DOES render that branch, so run the same family over its rendered text.
// `runsRenderingTheChips` is the non-vacuity guard: every run must actually have reached the
// post-scan branch, or "no claim found" would just mean "nothing was rendered".
{
  const texts = Object.entries(scan.runs || {}).map(([k, v]) => [k, v?.text || '']);
  const hits = texts.filter(([, t]) => DECEPTIVE.test(t)).map(([k, t]) => ({ run: k, matched: t.match(DECEPTIVE)?.[0] }));
  const rendered = texts.filter(([, t]) => t.includes('Documents · 9700')).length;
  rec('C3 COPY — no absolute claim in the SCANNED branch either, where consent is actually given',
    !!scan.mounted && texts.length >= 3 && rendered === texts.length && hits.length === 0,
    JSON.stringify({ runsRenderingTheChips: rendered, of: texts.length, hits }));
}
// C-CTRL2 — the family must actually FIRE. A regex this elaborate is a liability if a typo
// makes it match nothing: every "no claim found" above would be free. Drive it over the
// phrasings round 2 proved were misses, plus the two originals.
{
  const MUST_MATCH = [
    'nothing leaves your machine', 'nothing leaves your device',
    'Your files never leave your Mac.', 'Your thoughts never leave this device.',
    'Not a byte leaves your device.', 'No file ever leaves your Mac.',
    'Nothing about your files leaves this Mac.', 'nothing is ever uploaded',
    'your data stays on this Mac', 'Your data is never sent anywhere.',
    '100% local', 'fully private', 'It does not leave your Mac.',
  ];
  const MUST_NOT = [
    'Mycelium reads these files and stores them on your device to build your map.',
    'Obsidian, Claude Code, Hermes, OpenClaw & your files — found locally on this Mac.',
    'Import your data. It\'s stored encrypted on your device.',
    'Will import 9,700 files · documents only',
  ];
  const missed = MUST_MATCH.filter((x) => !DECEPTIVE.test(x));
  const falsePos = MUST_NOT.filter((x) => DECEPTIVE.test(x));
  rec('C-CTRL2 COPY (control) — the claim family matches every known phrasing and none of the accurate copy',
    missed.length === 0 && falsePos.length === 0, JSON.stringify({ missed, falsePos }));
}

const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — import consent: a deselected category never reaches disk (click → wire → route → vault), an empty/missing selection fails CLOSED, and the onboarding claim is accurate`);
raw.close();
server.close();
await close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync(tmpRoot, { recursive: true }); } catch { /* */ }
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
