/**
 * verify:cvp-labeling-api — the portal CVP-labels endpoints (P3c).
 *
 * Boots the router on an ephemeral express app with a stub auth and exercises it over
 * HTTP: auth gate (401), GET /labels/status shape, POST /labels save, POST
 * /labels/run-cvp full verdict path, and body validation (unknown axis → 400). CVP
 * correctness itself is covered by verify:cvp-labeling; this proves the HTTP layer.
 */
import express from 'express';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { createLabelsNamespace } from '../src/db/labels.js';
import { createAnchorNamespace } from '../src/db/anchor.js';
import { portalLabelsRouter } from '../src/portal-labels.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const dbx = new Database(':memory:');
applyMigrations(dbx);
const d1Query = async (sql, params = []) => {
  const s = dbx.prepare(sql);
  if (/^\s*select/i.test(sql)) return { results: s.all(...params) };
  const info = s.run(...params); return { results: [], meta: { changes: info.changes } };
};
const firstRow = (r) => (r?.results ?? r?.rows ?? [])[0] ?? null;
const U = 'u1', V = 'v3-2026-06-24', G = 'alpha', ERA = 'era1', N = 25;
const db = {
  d1Query, rawQuery: d1Query,
  labels: createLabelsNamespace({ d1Query }),
  anchor: createAnchorNamespace({ d1Query, firstRow }),
  // stub content reader (real one auto-decrypts; here we just prove the sampler wires it)
  messages: { selectPaginated: async (_uid, { since }) => ({ messages: [{ role: 'user', created_at: since, content: 'window content to rate' }] }) },
};

// Seed: separability for all axes (tone measurable+pending) + leans + genuine tone labels.
for (const ax of ['tone', 'charge', 'warmth', 'gatheredness', 'holding', 'noticing', 'edges', 'kusala']) {
  dbx.prepare(`INSERT INTO cognitive_axis_separability (axis, anchor_version, measurable, seed_count, cvp_status, computed_at)
               VALUES (?,?,1,48,'pending', '2026-06-24T00:00:00Z')`).run(ax, V);
}
const ins = dbx.prepare(`INSERT INTO cognitive_metrics_anchor
  (user_id, window_end, granularity, era_id, language, anchor_version, tone_lean, cvp_status, message_count, low_confidence)
  VALUES (?,?,?,?, 'en', ?, ?, 'pending', ?, 1)`);
for (let i = 0; i < N; i++) {
  const w = `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
  const lean = Math.sin(i * 0.5);
  ins.run(U, w, G, ERA, V, lean, 10 + (i % 5));
  await db.labels.saveLabel(U, { axis: 'tone', anchorVersion: V, windowEnd: w, granularity: G, eraId: ERA, target: lean + 0.05 * Math.cos(i * 3) });
}

const app = express();
app.use(express.json());
const stubAuth = (req) => (req.headers['x-auth'] === 'ok' ? { id: U } : null);
app.use('/api/v1/portal', portalLabelsRouter({ db, userId: U, authenticatePortalRequest: stubAuth }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;
const J = (extra = {}) => ({ headers: { 'content-type': 'application/json', 'x-auth': 'ok', ...extra } });

try {
  // 1. auth gate
  const un = await fetch(`${base}/labels/status`);
  rec('1. unauthenticated → 401', un.status === 401, `status=${un.status}`);

  // 2. GET status shape
  const st = await (await fetch(`${base}/labels/status`, J())).json();
  const tone = st.axes?.find((a) => a.axis === 'tone');
  rec('2. GET /labels/status → 8 axes + per-axis label count', st.ok && st.axes?.length === 8 && tone?.labels === N && tone?.cvp_status === 'pending',
    `version=${st.anchorVersion} axes=${st.axes?.length} tone.labels=${tone?.labels} tone.status=${tone?.cvp_status}`);

  // 3. POST /labels save
  const sv = await fetch(`${base}/labels`, { method: 'POST', ...J(), body: JSON.stringify({ axis: 'warmth', anchorVersion: V, windowEnd: '2026-06-26T00:00:00Z', granularity: G, eraId: ERA, target: 0.4 }) });
  const svj = await sv.json();
  const warmthN = await db.labels.countLabels(U, { axis: 'warmth', anchorVersion: V });
  rec('3. POST /labels saves a label', sv.status === 200 && svj.ok === true && warmthN === 1, `status=${sv.status} count=${warmthN}`);

  // 4. POST /labels bad axis → 400
  const bad = await fetch(`${base}/labels`, { method: 'POST', ...J(), body: JSON.stringify({ axis: 'nope', anchorVersion: V, windowEnd: 'x', granularity: G, eraId: ERA, target: 0 }) });
  rec('4. POST /labels unknown axis → 400', bad.status === 400, `status=${bad.status}`);

  // 5. POST /labels/run-cvp tone → pass verdict (full path)
  const rc = await (await fetch(`${base}/labels/run-cvp`, { method: 'POST', ...J(), body: JSON.stringify({ axis: 'tone', anchorVersion: V, granularity: G }) })).json();
  rec('5. POST /labels/run-cvp → genuine tone PASSES (n>=min_n)', rc.ok && rc.status === 'pass' && rc.n === N, `status=${rc.status} n=${rc.n}`);

  // 6. status reflects the flip
  const st2 = await (await fetch(`${base}/labels/status`, J())).json();
  rec('6. GET /labels/status reflects tone=pass after run-cvp', st2.axes?.find((a) => a.axis === 'tone')?.cvp_status === 'pass');

  // 7. GET /labels/sample returns UNLABELED windows + content (charge has no labels).
  const smp = await (await fetch(`${base}/labels/sample?axis=charge&n=3`, J())).json();
  const allHaveContent = smp.windows?.every((w) => Array.isArray(w.messages) && w.messages.length > 0 && w.window_start);
  rec('7. GET /labels/sample → unlabeled windows + content (no lean exposed)',
    smp.ok && smp.windows?.length === 3 && allHaveContent && !JSON.stringify(smp).includes('lean'),
    `windows=${smp.windows?.length} content=${allHaveContent}`);

  // 8. sample EXCLUDES already-labeled windows (tone is fully labeled → empty).
  const smpTone = await (await fetch(`${base}/labels/sample?axis=tone&n=5`, J())).json();
  rec('8. GET /labels/sample excludes already-labeled windows (tone fully labeled → 0)',
    smpTone.ok && smpTone.windows?.length === 0, `windows=${smpTone.windows?.length}`);

  // 9. GET /labels/leans surfaces ONLY the CVP-passed axis (tone), gated fail-closed.
  const lns = await (await fetch(`${base}/labels/leans`, J())).json();
  const toneLean = lns.leans?.find((l) => l.axis === 'tone');
  rec('9. GET /labels/leans surfaces passed tone, omits pending axes (gated)',
    lns.ok && toneLean && typeof toneLean.value === 'number' && !lns.leans.some((l) => l.axis === 'charge'),
    `leans=${JSON.stringify(lns.leans)}`);
} finally {
  server.close();
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — portal CVP-labels endpoints auth-gated + functional' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
