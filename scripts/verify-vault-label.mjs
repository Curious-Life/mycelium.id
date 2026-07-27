// verify:vault-label — the sidebar footer shows the user's HANDLE once they have claimed one.
//
// THE DEFECT (operator, v0.1.14): "instead of … My Mycelium, it should show the handle the user
// set" — then, on being told the chain already existed: "but it doesnt. even after i have set a
// handle it still shows my mycelium."
//
// The label CHAIN was correct all along (vaultDisplayLabel: handle → `@handle`, else the
// default). What was wrong was the READ. GET /portal/profile replies
//
//     { profile: { handle, avatar_url, … } }        portal-compat.js:436
//
// (`ok(res, body)` is `res.json(body)` verbatim — nothing unwraps it), and Sidebar read
// `d?.handle` at the TOP level. Always undefined ⇒ userHandle always null ⇒ the footer showed
// "My Mycelium" for every user with a claimed handle. The same line read `d?.avatar_url`, so no
// user's avatar ever rendered either.
//
// ⚠️ IT FAILED SILENTLY, AND THAT IS THE POINT. Optional chaining on a MISSING KEY is
// indistinguishable from a key that is legitimately null — and null is exactly the state the
// "My Mycelium" fallback exists to render. A wrong path and a genuinely unset handle produce
// byte-identical UI, so no amount of looking at the screen could tell them apart. That is why
// this gate asserts the two sides AGREE ON THE SHAPE rather than merely that the label function
// works: the label function was never broken.
//
//   V1  the label chain itself: handle → `@handle`, absent/blank → "My Mycelium"
//   V2  ⭐ the accessor reads the SERVER's actual nesting — driven with the real payload shape
//   V3  a top-level `handle` (the OLD wrong shape) yields null, so the bug cannot be re-made
//       by "helpfully" accepting both
//   V4  the SERVER really does nest under `profile` — read out of portal-compat.js, so the day
//       the route changes shape this gate REDs instead of the UI going quietly wrong
//   V5  Sidebar uses the shared accessors, not a hand-written path
//
// MUTATION-TESTED: reverted the accessor to `d?.handle` (the shipped bug) → V2 REDs.
// MUTATION-TESTED: made the accessor accept BOTH nestings (`d?.profile?.handle ?? d?.handle`)
//   → V3 REDs. Tolerating the old shape is how a "compatible" fix keeps the defect alive.
// MUTATION-TESTED: pointed Sidebar back at an inline `(d?.handle || '').trim()` → V5 REDs.
// MUTATION-TESTED: changed portal-compat.js to reply un-nested → V4 REDs (client/server disagree).
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Load the REAL module (plain TS: types stripped natively by the npm script's flag).
const { vaultDisplayLabel, DEFAULT_VAULT_LABEL, handleFromProfileResponse, avatarFromProfileResponse } =
  await import('../portal-app/src/lib/vault-label.ts');

// ── V1: the chain ────────────────────────────────────────────────────────────
{
  const cases = [
    ['martin', '@martin'],
    ['  spaced  ', '@spaced'],
    [null, DEFAULT_VAULT_LABEL],
    ['', DEFAULT_VAULT_LABEL],
    ['   ', DEFAULT_VAULT_LABEL],
  ];
  const bad = cases.filter(([i, want]) => vaultDisplayLabel(i) !== want);
  rec('V1. the label chain: a claimed handle wins, absent/blank falls back',
    bad.length === 0 && DEFAULT_VAULT_LABEL === 'My Mycelium',
    bad.length ? bad.map(([i, w]) => `${JSON.stringify(i)} → ${JSON.stringify(vaultDisplayLabel(i))} (want ${w})`).join(' · ')
      : cases.map(([i, w]) => `${JSON.stringify(i)}→${w}`).join(' · '));
}

// ── V2: ⭐ the accessor reads the SERVER's real nesting ──────────────────────
{
  const real = { profile: { handle: 'martin', avatar_url: 'https://x/a.png', display_name: 'Martin' } };
  const h = handleFromProfileResponse(real);
  const a = avatarFromProfileResponse(real);
  rec('V2. ⭐ the accessor reads the handle at the nesting the ROUTE actually sends',
    h === 'martin' && a === 'https://x/a.png' && vaultDisplayLabel(h) === '@martin',
    `handle=${JSON.stringify(h)} avatar=${JSON.stringify(a)} label=${JSON.stringify(vaultDisplayLabel(h))}`);
}

// ── V3: the OLD shape must NOT be accepted ───────────────────────────────────
// Accepting both would "work" and quietly keep the defect alive for the next reader.
{
  const oldShape = { handle: 'martin', avatar_url: 'https://x/a.png' };
  rec('V3. a TOP-LEVEL handle (the old wrong shape) is not accepted — the bug cannot be re-made',
    handleFromProfileResponse(oldShape) === null && avatarFromProfileResponse(oldShape) === null,
    `handle=${JSON.stringify(handleFromProfileResponse(oldShape))}`);
}

// ── V4: the server really nests — read from the route source ────────────────
{
  const compat = readFileSync('src/portal-compat.js', 'utf8');
  const nests = /router\.get\('\/profile',[\s\S]{0,220}?ok\(res,\s*\{\s*profile:/.test(compat);
  const okIsVerbatim = /const ok = \(res, body\) => res\.json\(body\);/.test(compat);
  rec('V4. GET /profile really replies { profile: … }, and ok() does not unwrap it',
    nests && okIsVerbatim,
    `nested=${nests} okVerbatim=${okIsVerbatim}`);
}

// ── V5: the Sidebar uses the SHARED accessors ────────────────────────────────
{
  const sb = readFileSync('portal-app/src/lib/components/shell/Sidebar.svelte', 'utf8');
  const usesShared = /handleFromProfileResponse\(d\)/.test(sb) && /avatarFromProfileResponse\(d\)/.test(sb);
  const handRolled = /\(d\?\.(handle|avatar_url)\s*\|\|\s*''\)/.test(sb);
  rec('V5. Sidebar reads through the shared accessors, not a hand-written path',
    usesShared && !handRolled,
    `shared=${usesShared} handWritten=${handRolled}`);
}

const allPass = ledger.every(Boolean);
console.log('');
console.log(allPass
  ? 'VERDICT: GO — a claimed handle reaches the sidebar footer: the accessor reads the nesting the\n'
    + '        route actually sends, the old top-level shape is refused so the defect cannot return,\n'
    + '        and the client and server agree on the shape by assertion rather than by luck.\n'
    + '        NOT PROVEN: that the handle was successfully CLAIMED — verify:handle owns that.'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(allPass ? 0 : 1);
