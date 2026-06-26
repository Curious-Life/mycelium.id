/**
 * verify:cvp-labeling — the operator-label → CVP → surface loop (P3b).
 *
 * Proves end-to-end on a fixture DB (no boot/keys/model): seed computed leans +
 * operator labels, run runAxisCvpFromLabels, and confirm a GENUINELY-correlated axis
 * flips to cvp_status='pass' and then SURFACES through the gated reader, while a noise
 * axis stays 'fail'/pending and stays REFUSED. Also checks the getLeansForCvp allowlist
 * (fail-closed on unknown axis) and that the raw-lean read stays inside the sanctioned
 * reader (no new ungated reader of cognitive_metrics_anchor).
 */
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createLabelsNamespace } from '../src/db/labels.js';
import { createAnchorNamespace } from '../src/db/anchor.js';
import { runAxisCvpFromLabels } from '../src/metrics/axis-cvp.js';
import { renderInnerStateLeans } from '../src/tools/context.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const db0 = new Database(':memory:');
applyMigrations(db0);

const d1Query = async (sql, params = []) => {
  const s = db0.prepare(sql);
  if (/^\s*select/i.test(sql)) return { results: s.all(...params) };
  const info = s.run(...params);
  return { results: [], meta: { changes: info.changes } };
};
const firstRow = (r) => (r?.results ?? r?.rows ?? [])[0] ?? null;
const db = {
  rawQuery: d1Query,
  labels: createLabelsNamespace({ d1Query }),
  anchor: createAnchorNamespace({ d1Query, firstRow }),
};

const U = 'u1', V = 'v3-2026-06-24', G = 'alpha', ERA = 'era1', N = 25;

// Separability rows (measurable, pending) — applyAxisCVP UPDATEs these; the gated
// reader resolves per-axis status from here.
for (const ax of ['tone', 'charge']) {
  db0.prepare(`INSERT INTO cognitive_axis_separability (axis, anchor_version, loo_auc, antonym_cos, measurable, seed_count, cvp_status)
               VALUES (?,?,?,?,?,?, 'pending')`).run(ax, V, 0.85, 0.97, 1, 48);
}

// Seed N windows: tone_lean = signal; charge_lean = an unrelated signal; message_count
// low-correlation (so incremental validity is a real test).
const ins = db0.prepare(`INSERT INTO cognitive_metrics_anchor
  (user_id, window_end, granularity, era_id, language, anchor_version,
   tone_lean, charge_lean, cvp_status, message_count, low_confidence)
  VALUES (?,?,?,?, 'en', ?, ?,?, 'pending', ?, 1)`);
const labelGenuine = [], labelNoise = [];
for (let i = 0; i < N; i++) {
  const w = `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
  const toneLean = Math.sin(i * 0.5);
  const chargeLean = Math.cos(i * 1.3);
  const msg = 10 + (i % 5);
  ins.run(U, w, G, ERA, V, toneLean, chargeLean, msg);
  // tone label: correlated with tone_lean (genuine construct validity)
  labelGenuine.push({ w, target: toneLean + 0.05 * Math.cos(i * 3) });
  // charge label: uncorrelated with charge_lean (no validity)
  labelNoise.push({ w, target: ((i * 7) % 11) - 5 });
}
for (const { w, target } of labelGenuine) {
  await db.labels.saveLabel(U, { axis: 'tone', anchorVersion: V, windowEnd: w, granularity: G, eraId: ERA, target });
}
for (const { w, target } of labelNoise) {
  await db.labels.saveLabel(U, { axis: 'charge', anchorVersion: V, windowEnd: w, granularity: G, eraId: ERA, target });
}

// Topic-confounded axis (warmth): the lean AND the label both really track TOPIC
// (frequency_snapshots.entropy), not a distinct construct. It must FAIL discriminant
// validity once the entropy confound is wired — even though lean⇄target correlate.
db0.prepare(`INSERT INTO cognitive_axis_separability (axis, anchor_version, measurable, seed_count, cvp_status) VALUES ('warmth',?,1,48,'pending')`).run(V);
const updW = db0.prepare('UPDATE cognitive_metrics_anchor SET warmth_lean=? WHERE user_id=? AND window_end=? AND granularity=? AND anchor_version=?');
const insFS = db0.prepare('INSERT INTO frequency_snapshots (user_id, window_start, window_end, granularity, entropy) VALUES (?,?,?,?,?)');
for (let i = 0; i < N; i++) {
  const w = `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
  const topic = ((i * 7) % 5) / 5;                      // sawtooth — decorrelated from tone's sin
  updW.run(topic + 0.03 * Math.cos(i * 5), U, w, G, V); // warmth_lean ≈ topic
  insFS.run(U, w, w, G, topic);                         // entropy = topic (the confound)
  await db.labels.saveLabel(U, { axis: 'warmth', anchorVersion: V, windowEnd: w, granularity: G, eraId: ERA, target: topic + 0.03 * Math.sin(i * 7) });
}

// 1. getLeansForCvp returns the raw leans (internal), allowlists the axis.
const leans = await db.anchor.getLeansForCvp(U, { axis: 'tone', anchorVersion: V, granularity: G });
rec('1. getLeansForCvp returns raw leans per window (internal CVP read)', leans.length === N && typeof leans[0].lean === 'number',
  `n=${leans.length}`);
let threwUnknown = false;
try { await db.anchor.getLeansForCvp(U, { axis: 'not_an_axis', anchorVersion: V }); } catch { threwUnknown = true; }
rec('2. getLeansForCvp FAILS CLOSED on an unknown axis (no raw SQL interpolation)', threwUnknown);

// 3. Genuine labels → runAxisCvpFromLabels flips tone to PASS (persisted).
const repTone = await runAxisCvpFromLabels(db, { userId: U, axis: 'tone', anchorVersion: V, granularity: G });
const toneStatus = db0.prepare("SELECT cvp_status, cvp_labeled_n FROM cognitive_axis_separability WHERE axis='tone' AND anchor_version=?").get(V);
rec('3. genuine labels → tone CVP PASS (persisted, n>=min_n)', repTone.status === 'pass' && toneStatus.cvp_status === 'pass' && toneStatus.cvp_labeled_n === N,
  `report=${repTone.status} stored=${toneStatus.cvp_status} n=${toneStatus.cvp_labeled_n}`);

// 4. Noise labels → charge stays NOT pass.
const repCharge = await runAxisCvpFromLabels(db, { userId: U, axis: 'charge', anchorVersion: V, granularity: G });
const chargeStatus = db0.prepare("SELECT cvp_status FROM cognitive_axis_separability WHERE axis='charge' AND anchor_version=?").get(V);
rec('4. noise labels → charge NOT pass (stays refused)', repCharge.status !== 'pass' && chargeStatus.cvp_status !== 'pass',
  `report=${repCharge.status} stored=${chargeStatus.cvp_status}`);

// 5. The gated reader now SURFACES the passed axis (tone) and REFUSES the unvalidated one (charge).
const win = await db.anchor.getCurrentWindow(U, { granularity: G });
rec('5. gated reader SURFACES passed tone_lean, REFUSES charge_lean',
  win.refusals.tone_lean === undefined && typeof win.refusals.charge_lean === 'string' && win.values.tone_lean !== null,
  `tone_value=${win.values.tone_lean} tone_refused=${win.refusals.tone_lean !== undefined} charge_refused=${win.refusals.charge_lean !== undefined}`);

// 6. No NEW ungated reader of cognitive_metrics_anchor (the raw read stays in anchor.js).
const grep = execSync(`grep -rlEi '(from|join|into|update)[[:space:]]+cognitive_metrics_anchor' --include=*.js --include=*.mjs src || true`, { encoding: 'utf8' });
const readers = grep.split('\n').map((s) => s.trim().replace(/^\.\//, '')).filter(Boolean);
const ungated = readers.filter((p) => p !== 'src/db/anchor.js');
rec('6. NO ungated reader of cognitive_metrics_anchor (raw CVP read stays in anchor.js)', ungated.length === 0,
  `readers=[${readers.join(', ')}] ungated=[${ungated.join(', ') || 'none'}]`);

// 7. P4 surfacing: renderInnerStateLeans renders the passed axis, omits the refused one.
const block = renderInnerStateLeans(win);
rec('7. getContext render surfaces passed tone, omits refused charge',
  typeof block === 'string' && /(^|\n)- tone: leans /.test(block) && !/charge/.test(block),
  `block=${JSON.stringify(block)}`);

// 8. P4 fail-closed: a window with no surfaceable leans renders NOTHING (no section).
const empty = renderInnerStateLeans({ values: { tone_lean: null, charge_lean: null } });
rec('8. getContext render emits NOTHING when no axis has passed (fail-closed silence)', empty === null);

// 9. DISCRIMINANT confound: the topic-confounded warmth axis must FAIL — its lean tracks
// entropy (topic), not a construct distinct from topic. Proves the entropy confound bites.
const repWarmth = await runAxisCvpFromLabels(db, { userId: U, axis: 'warmth', anchorVersion: V, granularity: G });
rec('9. topic-confounded axis FAILS discriminant (entropy confound bites, not just rTarget)',
  repWarmth.status === 'fail' && repWarmth.criteria?.discriminant_validity?.pass === false,
  `status=${repWarmth.status} discriminant=${repWarmth.criteria?.discriminant_validity?.pass} rTarget=${repWarmth.criteria?.discriminant_validity?.target_abs_corr?.toFixed?.(2)} entropyConf=${repWarmth.criteria?.discriminant_validity?.confound_abs_corrs?.topic_entropy?.toFixed?.(2)}`);

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — operator-label → CVP → surface loop correct; fail-closed preserved' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
