// verify:curious-resonance — unit-tests GET /curious/resonance without a server.
// Invokes the route handler with a mock db + auth; asserts (1) a territory whose
// centroid equals a figure's own centroid surfaces that figure #1 (correctness),
// (2) the response carries NO raw centroid (security — CLAUDE.md §7), (3) shape.
import fs from 'node:fs';
import { portalMeasurementRouter } from '../src/portal-measurement.js';

const ok = (c, m) => { if (!c) { console.log(`FAIL  ${m}`); process.exit(1); } console.log(`PASS  ${m}`); };

const asset = JSON.parse(fs.readFileSync(new URL('../src/curious/figureProfiles.json', import.meta.url), 'utf8'));
ok(asset.count >= 1900 && asset.dim === 256, `asset loaded (${asset.count} figures, dim ${asset.dim})`);

const target = asset.figures.find((f) => f.name === 'John C. Lilly') || asset.figures[0];

// mock db: a realm/theme/territory whose centroid IS the target figure's own →
// that figure must rank #1 at every level (cosine 1.0 = global max).
const C = JSON.stringify(target.centroid);
const mockDb = {
  rawQuery: async (sql) => {
    if (/FROM realms/.test(sql)) return { results: [{ realm_id: 1, name: 'Realm A', message_count: 10, centroid_256: C }] };
    if (/semantic_themes/.test(sql)) return { results: [{ realm_id: 1, semantic_theme_id: 1, name: 'Theme A', centroid_256: C }] };
    return { results: [{ territory_id: 1, name: 'my topic', realm_id: 1, semantic_theme_id: 1, message_count: 12, current_vitality: 0.8, centroid_256: C }] };
  },
};
const router = portalMeasurementRouter({ db: mockDb, userId: 'u', authenticatePortalRequest: () => ({ id: 'u' }) });
const layer = router.stack.find((l) => l.route && l.route.path === '/curious/resonance' && l.route.methods.get);
ok(!!layer, 'route /curious/resonance GET registered');
const handler = layer.route.stack[layer.route.stack.length - 1].handle;

let captured = null, code = 200;
const res = { statusCode: 200, status(c) { code = c; this.statusCode = c; return this; }, json(o) { captured = o; return this; }, set() { return this; } };
await handler({}, res);

ok(code === 200 && captured && captured.available === true, `200 + available (territory_count=${captured?.territory_count})`);
ok(Array.isArray(captured.top) && captured.top.length > 0, `top figures returned (${captured.top.length})`);
ok(captured.top[0].name === target.name, `dominant match is the target figure (${captured.top[0].name} @ ${captured.top[0].affinity}%)`);
ok(Array.isArray(captured.top[0].via) && captured.top[0].via.includes('my topic'), `top figure carries the 'why' (via your topics): ${JSON.stringify(captured.top[0].via)}`);
ok(captured.top[0].affinity >= captured.top[captured.top.length - 1].affinity, 'affinity is sorted descending');
ok(Array.isArray(captured.constellationAffinity) && captured.constellationAffinity.length > 0, 'constellation affinity present');
ok(captured.byTerritory.every((t) => Array.isArray(t.top) && !('centroid' in t)), 'per-territory rows carry figures, not centroids');

// PATH: realm → theme → territory all resolve to the target figure.
ok(Array.isArray(captured.realms) && captured.realms.length === 1, `path: ${captured.realms?.length} realm(s) returned`);
ok(captured.realms[0].figures[0]?.name === target.name, `realm resonates with target (${captured.realms[0].figures[0]?.name})`);
ok(captured.realms[0].themes[0]?.figures[0]?.name === target.name, 'theme resonates with target');
ok(captured.realms[0].themes[0]?.territories[0]?.figure?.name === target.name, 'territory resonates with target');

// SECURITY: the serialized response must not contain a raw centroid (a long float array) or the word "centroid".
const blob = JSON.stringify(captured);
ok(!/centroid/i.test(blob), 'response contains no "centroid" field (no embedding egress)');
const longArray = /\[(\s*-?\d\.\d+\s*,){50,}/.test(blob); // any array with 50+ floats = a leaked vector
ok(!longArray, 'response contains no raw embedding vector');

// fail-closed: unauthenticated request → 401, no body computed.
let code2 = 200, body2 = null;
const res2 = { status(c) { code2 = c; return this; }, json(o) { body2 = o; return this; }, set() { return this; } };
const denyRouter = portalMeasurementRouter({ db: mockDb, userId: 'u', authenticatePortalRequest: () => null });
const denyLayer = denyRouter.stack.find((l) => l.route && l.route.path === '/curious/resonance');
await denyLayer.route.stack[denyLayer.route.stack.length - 1].handle({}, res2);
ok(code2 === 401, 'unauthenticated request → 401 (fail-closed)');

// ── GET /curious/resonance/figure — figure detail + your-territory↔their-realm overlap ──
const realmAsset = JSON.parse(fs.readFileSync(new URL('../src/curious/figureRealmProfiles.json', import.meta.url), 'utf8'));
ok(realmAsset.count >= 1900 && realmAsset.realmCount >= 4000, `realm asset loaded (${realmAsset.count} figures, ${realmAsset.realmCount} realms)`);
const tgt = realmAsset.figures.find((f) => f.name === 'Oliver Sacks') || realmAsset.figures[0];
const r0 = tgt.realms[0];
// dequant realm0's RAW centroid → make a user territory whose centroid equals it (must rank #1).
const r0buf = Buffer.from(r0.q, 'base64');
const r0vec = Array.from({ length: 256 }, (_, i) => r0buf.readInt8(i) * r0.s);
const figDb = { rawQuery: async (sql) => /territory_profiles/.test(sql)
  ? { results: [{ name: 'my topic', centroid_256: JSON.stringify(r0vec) }] }
  : { results: [] } };
const figRouter = portalMeasurementRouter({ db: figDb, userId: 'u', authenticatePortalRequest: () => ({ id: 'u' }) });
const figLayer = figRouter.stack.find((l) => l.route && l.route.path === '/curious/resonance/figure' && l.route.methods.get);
ok(!!figLayer, 'route /curious/resonance/figure GET registered');
const figHandle = figLayer.route.stack[figLayer.route.stack.length - 1].handle;

let figCap = null, figCode = 200;
const figRes = { status(c) { figCode = c; return this; }, json(o) { figCap = o; return this; }, set() { return this; } };
await figHandle({ query: { name: tgt.name } }, figRes);
ok(figCode === 200 && figCap && figCap.available === true, `figure 200 + available (${tgt.name})`);
ok(figCap.name === tgt.name && Array.isArray(figCap.realms) && figCap.realms.length > 0, `profile populated (${figCap.realms.length} realms)`);
ok(figCap.cognitive && Object.keys(figCap.cognitive).length === 8, 'cognitive signature present (8 dims)');
ok(figCap.era && figCap.region, `bio fields present (${figCap.era} · ${figCap.region})`);
ok(Array.isArray(figCap.overlap) && figCap.overlap.length > 0, `overlap pairs returned (${figCap.overlap.length})`);
ok(figCap.overlap[0].theirRealm === r0.name && figCap.overlap[0].yourTerritory === 'my topic', `top pair joins your territory ↔ their realm (${figCap.overlap[0].yourTerritory} ↔ ${figCap.overlap[0].theirRealm} @ ${figCap.overlap[0].affinity})`);

// SECURITY: figure response must not leak a centroid / raw vector either.
const figBlob = JSON.stringify(figCap);
ok(!/centroid/i.test(figBlob), 'figure response contains no "centroid" field');
ok(!/\[(\s*-?\d\.\d+\s*,){50,}/.test(figBlob), 'figure response contains no raw embedding vector');

// unknown / mythic figure → 404, no compute.
let nfCode = 200;
await figHandle({ query: { name: 'Definitely Not A Figure 9000' } }, { status(c) { nfCode = c; return this; }, json() { return this; }, set() { return this; } });
ok(nfCode === 404, 'unknown figure → 404');

// fail-closed: unauthenticated figure request → 401.
let figDeny = 200;
const figDenyRouter = portalMeasurementRouter({ db: figDb, userId: 'u', authenticatePortalRequest: () => null });
const figDenyLayer = figDenyRouter.stack.find((l) => l.route && l.route.path === '/curious/resonance/figure');
await figDenyLayer.route.stack[figDenyLayer.route.stack.length - 1].handle({ query: { name: tgt.name } }, { status(c) { figDeny = c; return this; }, json() { return this; }, set() { return this; } });
ok(figDeny === 401, 'unauthenticated figure request → 401 (fail-closed)');

console.log('\n================================================================');
console.log('VERDICT: GO — /curious/resonance + /figure match correctly, leak no centroids, fail closed');
console.log('================================================================');
