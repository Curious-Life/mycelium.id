// scripts/verify-portal-provider-locality.mjs — "on your device" must mean THIS MACHINE.
//
// THE BUG (independent review, 2026-07-16; the 4th instance of "local != this machine").
// AISettings.svelte:333 re-derived locality in the CLIENT with an unanchored substring regex
// over the whole URL string:
//     /127\.0\.0\.1|localhost|11434|:1234/.test(base_url)
// No host parse, so `https://evil.example.com/v1?x=11434` (match in the QUERY STRING) and
// `https://localhost.evil.example.com/v1` (loopback-PREFIXED domain) both read as "local" —
// and both are reachable: assertSafeBaseUrlResolved accepts a public https host, so the row
// stores. The chip then rendered JURIS.local = "on your device", in green, for an internet
// host. That is a FALSE SOVEREIGNTY CLAIM in the one surface the user trusts to tell them
// where their most intimate data goes. The realistic victim is not an attacker: a perfectly
// ordinary LAN Ollama at `http://192.168.1.9:11434/v1` tripped it too.
//
// THE FIX: the SERVER computes both facts in publicRow (src/portal-providers.js) with the one
// shared parser (src/inference/presets.js), and the client renders them. No frontend parser.
//
// WHY TWO FIELDS. `jurisdictionForBaseUrl` maps a `.local` host to 'local' (a LAN box: not
// this device). Gating the green chip on `jurisdiction === 'local'` would re-ship the bug
// inverted for every `.local` host. So:
//     on_this_device := isLoopbackUrl(base_url)          → the "on your device" claim
//     jurisdiction   := jurisdictionForBaseUrl(base_url) → the legal-exposure chip
//
// METHOD (deliberate, and the reason this file is not a URL table). An earlier gate for this
// same bug class pinned THREE example URLs; two reviewers broke the fix with mutations the
// gate stayed green for. So P1-P3 assert the PROPERTY — on_this_device IFF isLoopbackUrl —
// over a large adversarial + fuzzed corpus, driving the REAL router over REAL HTTP (a stub
// db only supplies rows; publicRow itself is never re-implemented here). P4/P5 are source
// asserts that the frontend cannot grow a parser back.
import http from 'node:http';
import express from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import { portalProvidersRouter } from '../src/portal-providers.js';
import { isLoopbackUrl, jurisdictionForBaseUrl } from '../src/inference/presets.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── The corpus. Every entry is a URL a base_url could hold; the EXPECTATION is not written
//    per-URL — it is computed from isLoopbackUrl, so this can never drift from the parser. ──
const ATTACK = [
  'https://evil.example.com/v1?x=11434',        // the reported bug: match in the query string
  'https://evil.example.com/v1?x=localhost',
  'https://evil.example.com/v1?x=127.0.0.1',
  'https://localhost.evil.example.com/v1',      // loopback-PREFIXED domain
  'https://127.0.0.1.evil.example.com/v1',
  'https://evil.example.com:11434/v1',          // the port alone means nothing off-box
  'https://evil.example.com/127.0.0.1/v1',      // in the PATH
  'https://evil.example.com/v1#localhost',      // in the FRAGMENT
  'https://user:localhost@evil.example.com/v1', // in USERINFO — a classic parser split
  'https://evil.example.com/v1?x=:1234',
  'http://192.168.1.9:11434/v1',                // the REALISTIC one: a LAN Ollama
  'http://10.0.0.5:1234/v1',
  'http://myhost.local/v1',                     // jurisdiction 'local', but NOT this device
];
const ONBOX = [
  'http://127.0.0.1:11434/v1',
  'http://localhost:11434/v1',
  'http://127.0.0.1:1234/v1',
  'http://[::1]:11434/v1',
  'http://127.0.0.2:11434/v1',                  // the whole 127/8 block
  'http://0.0.0.0:11434/v1',
  'http://[::ffff:127.0.0.1]:11434/v1',
];
// Fuzz: splice loopback tokens into every structural position of an off-box URL. None of
// these is on-box; a substring detector says otherwise for most.
const TOKENS = ['127.0.0.1', 'localhost', '11434', ':1234', '0.0.0.0'];
const SHAPES = [
  (t) => `https://evil.example.com/v1?q=${t}`,
  (t) => `https://evil.example.com/${t}/v1`,
  (t) => `https://${t}.evil.example.com/v1`,
  (t) => `https://evil.example.com/v1#${t}`,
  (t) => `https://evil.example.com/v1?${t}=1`,
];
const FUZZ = SHAPES.flatMap((s) => TOKENS.map((t) => s(t)));
const CORPUS = [...ATTACK, ...ONBOX, ...FUZZ, null, '', 'not a url', 'http://'];

// ── Boot the REAL router over REAL HTTP. The stub db only hands back rows. ──
const rows = CORPUS.map((base_url, i) => ({
  id: i + 1, provider: 'custom', label: `p${i}`, auth_type: 'key',
  model_preference: 'llama3.1:8b', base_url, is_active: i === 0, status: 'ok',
  credentials: 'SHOULD-NEVER-BE-RETURNED',
  last_used_at: null, created_at: null, updated_at: null,
}));
const db = { providers: { list: async () => rows } };
const app = express();
app.use(express.json());
app.use('/portal', portalProvidersRouter({ db, userId: 'local-user' }));
const srv = http.createServer(app);
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const res = await fetch(`http://127.0.0.1:${PORT}/portal/providers`);
const body = await res.json();
ok(res.status === 200 && Array.isArray(body.providers), 'GET /portal/providers serves rows');
const got = body.providers || [];
ok(got.length === rows.length, 'every row is shaped', `${got.length}/${rows.length}`);

// ── P1 — THE PROPERTY: on_this_device IFF isLoopbackUrl(base_url). Not a table. ──
{
  const bad = got.filter((p, i) => p.on_this_device !== isLoopbackUrl(rows[i].base_url));
  ok(bad.length === 0, `P1 on_this_device IFF isLoopbackUrl (${got.length} urls)`,
    bad.length ? `first divergence: ${JSON.stringify(rows[got.indexOf(bad[0])].base_url)}` : '');
}

// ── P2 — the chip agrees with the POLICY path (inference/resolve.js computes the same). ──
{
  const bad = got.filter((p, i) => p.jurisdiction !== jurisdictionForBaseUrl(rows[i].base_url, rows[i].provider));
  ok(bad.length === 0, `P2 jurisdiction === jurisdictionForBaseUrl (${got.length} urls)`);
}

// ── P3 — THE SECURITY PROPERTY, stated as the harm: no off-box URL may EVER be able to
//    render the green claim. This is the assert that must survive any refactor. ──
{
  const lying = ATTACK.concat(FUZZ).filter((u, i) => {
    const p = got[CORPUS.indexOf(u)];
    return p && p.on_this_device === true;
  });
  ok(lying.length === 0, `P3 no off-box url claims "on your device" (${ATTACK.length + FUZZ.length} hostile urls)`,
    lying.length ? `LEAKED: ${lying.slice(0, 3).join(', ')}` : '');
  const onbox = ONBOX.filter((u) => got[CORPUS.indexOf(u)]?.on_this_device !== true);
  // Fail-closed cuts both ways: a false NEGATIVE mislabels a real on-box Ollama as US.
  ok(onbox.length === 0, `P3b every real on-box url IS recognised (${ONBOX.length})`,
    onbox.length ? `MISSED: ${onbox.join(', ')}` : '');
}

// ── P4 — `.local` (mDNS = a DIFFERENT machine): never on_this_device, and since #175
// (§4g: `.local` was sovereign) jurisdictionForBaseUrl no longer grants it 'local' either —
// it falls to the us-standard fail-safe. This assertion was written pre-#175 expecting
// jurisdiction 'local'; the hygiene clobber (9cfab86) deleted this gate before the two
// could be reconciled on main, so the mismatch first surfaced in the restore (2026-07-16).
{
  const p = got[CORPUS.indexOf('http://myhost.local/v1')];
  ok(p?.jurisdiction === 'us-standard' && p?.on_this_device === false,
    'P4 a .local LAN host is us-standard (fail-safe, #175) and NOT on_this_device',
    `juris=${p?.jurisdiction} on_this_device=${p?.on_this_device}`);
}

// ── P5 — the listing still never echoes credentials (publicRow's other job). ──
ok(!JSON.stringify(body).includes('SHOULD-NEVER-BE-RETURNED'), 'P5 credentials never echoed');

// ── P6 — the CLIENT must not grow a URL parser back. DENY-BY-DEFAULT ON THE TOKEN.
//
// The first draft of this check enumerated DETECTION FORMS (`.test(`, `.includes(`, `match(`)
// — and I defeated it in five minutes: `.indexOf('localhost')`, `.search(/localhost/)`,
// `new RegExp('localhost')`, `'local'+'host'`, or simply putting the helper in a THIRD file
// all sailed through green. That is the house anti-pattern: a contract enforced on a
// PROJECTION (the form) while the whole line executes. The set of ways to test a string is
// open; it cannot be enumerated.
//
// So invert it: NO loopback token may appear ANYWHERE under portal-app/src, in any form, in
// any file, EXCEPT on an explicitly allowlisted line WITH a reason. Every current occurrence
// is a literal being DIALLED (configure), never a URL being CLASSIFIED (detect) — that is the
// distinction the allowlist encodes. A new detector, however it is written and wherever it is
// put, has to add a token → RED. Editing an allowlisted line breaks its exact match → RED, so
// an allowlisted "configure" literal cannot quietly become a "detect".
//
// Residual limit, stated honestly: a determined author who splits the token
// ('local'+'host') still evades this. That is deliberate sabotage, not the accidental
// regression this guards, and no source scan can win that fight — P1/P3 are the real floor,
// and they test the SERVER, which the client cannot talk its way around.
const TOKEN = /127\.0\.0\.1|localhost|11434|:1234|0\.0\.0\.0/;
const ALLOW = [
  ['settings/ConnectYourAISection.svelte', "const LOCAL = 'http://127.0.0.1:4711';", 'dials the local auth server'],
  ['settings/HarnessPickerSection.svelte', "const LOCAL = 'http://127.0.0.1:4711';", 'dials the local auth server'],
  ['settings/AISettings.svelte', "const OLLAMA_BASE = 'http://127.0.0.1:11434/v1';", 'the base_url WRITTEN when connecting on-box ollama'],
  // MindscapeInvite's entry removed 2026-07-16: increment E (#187) moved the intelligence
  // lanes into IntelligenceScreen, so the invite carries no loopback literal anymore —
  // the entry was stale (P6b) and deny-by-default now covers the file like any other.
  ['onboarding/OnboardingFlow.svelte', "base_url: 'http://127.0.0.1:11434/v1'", 'ditto (onboarding writes the row)'],
  ['settings/ChannelsSection.svelte', 'placeholder="Ollama URL (default :11434)"', 'placeholder TEXT shown to the user'],
];
{
  const root = new URL('../portal-app/src/', import.meta.url);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
    return e.isDirectory() ? walk(u) : (/\.(svelte|ts|js)$/.test(e.name) ? [u] : []);
  });
  const offenders = [];
  for (const f of walk(root)) {
    const rel = decodeURIComponent(f.href.slice(root.href.length));
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!TOKEN.test(line)) return;
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;  // prose
      if (ALLOW.some(([suffix, exact]) => rel.endsWith(suffix) && line.includes(exact))) return;
      offenders.push(`${rel}:${i + 1}: ${t.slice(0, 80)}`);
    });
  }
  ok(offenders.length === 0,
    'P6 portal-app/src: no un-allowlisted loopback token (deny-by-default, any file, any form)',
    offenders.length ? `\n      ${offenders.slice(0, 4).join('\n      ')}` : '');
  // C4-style: an allowlist entry that no longer matches anything is stale — it would silently
  // widen nothing today but rot into a licence later.
  const stale = ALLOW.filter(([suffix, exact]) =>
    !walk(root).some((f) => f.href.endsWith(suffix) && readFileSync(f, 'utf8').includes(exact)));
  ok(stale.length === 0, 'P6b no stale allowlist entry',
    stale.length ? stale.map(([s]) => s).join(', ') : '');
}
const SRC = { ai: 'portal-app/src/lib/components/settings/AISettings.svelte' };
{
  const src = readFileSync(new URL(`../${SRC.ai}`, import.meta.url), 'utf8');
  ok(/activeInfo\.local\}[\s\S]{0,120}ON_DEVICE\.label/.test(src),
    'P6c the green "on your device" chip is gated on the server field (activeInfo.local)');
  ok(!/local:\s*\{\s*label:\s*'on your device'/.test(src),
    'P6d JURIS.local no longer claims "on your device" (the .local inversion)');
  // Assert the USAGE, not the mere presence of the string: `/on_this_device/.test(src)` was
  // satisfied by the comments and the type alias alone — an independent reviewer removed every
  // real consumer and it still passed. Same projection trap as the first P6.
  ok(/local:\s*!!active\.on_this_device\b/.test(src),
    'P6e activeInfo.local IS the server field (not merely mentioned)');
  // The DESTRUCTIVE surface: `on_this_device` is the outer of the two guards on the Ollama
  // disk-delete offer. Ungating it carries no loopback token, so P6's token scan cannot see
  // it — this assert is the only thing holding that line. (Found by independent review: the
  // gate said GO with the disk-delete offered for every provider that has a model_preference.)
  ok(/isLocalProvider\s*=[^;\n]*\bp\.on_this_device\b\s*&&/.test(src),
    'P6g the disk-delete offer is gated on on_this_device');
}

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO');
process.exit(fail === 0 ? 0 : 1);
