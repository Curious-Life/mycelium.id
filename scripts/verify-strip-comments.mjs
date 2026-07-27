// verify:strip-comments — the gate on the GATES' comment stripper.
//
// scripts/lib/strip-comments.mjs is load-bearing for every source-reading gate in this
// repo: those gates assert against CODE so that a COMMENT cannot launder the bug it
// describes (the repo's oldest and most-repeated gate failure). The stripper it replaced
// was a regex chain, and a regex cannot tell a comment from a string — so it was wrong in
// both directions, and BOTH directions are a false GREEN:
//
//   UNDER-STRIP → prose satisfies a positive assert.
//   OVER-STRIP  → live code is deleted, satisfying a negative assert / balance count.
//
// C1  the reproduced hole: `"…"//` — a line comment whose preceding char is a quote
// C2  comment markers inside strings / templates / regex literals are NOT stripped
// C3  every real comment form IS stripped (html · block · line · css · nested-looking)
// C4  unterminated comments are stripped to EOF (never left behind as live text)
// C5  offsets/lines are preserved (blank, don't delete) so /m anchors stay honest
// C6  ⭐ SELF-MUTATION: the OLD regex chain FAILS this suite. A stripper self-test that
//     the broken implementation also passes proves nothing.
//
// MUTATION-TESTED: neuter the JS string-skip in strip-comments.mjs (replace
//   `i = skipString(src, i, c)` with `i++`, so string contents are scanned as code) →
//   C2a AND C2b RED (a `//` and a `/*` inside a string get wrongly stripped), gate NO-GO.
//   Restored → GO. Proves the OVER-strip/string-awareness half actually bites, not just C6.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert';
import { stripComments, stripCommentsFor, langOf } from './lib/strip-comments.mjs';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

// The implementation this replaces — kept ONLY so C6 can prove it fails these cases.
const OLD_REGEX_CHAIN = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1');

const has = (s, needle) => s.includes(needle);

// ── C1 — THE REPRODUCED HOLE ────────────────────────────────────────────────
// Verbatim shape of the mutation that kept verify:handle at "85 pass · 0 fail ·
// VERDICT: GO" with the live `unreachable` handling deleted from ProfileView.svelte.
const C1 = `<script lang="ts">
\tconst _hint = "handle check"// data?.unreachable → handleState = 'unreachable'
</script>`;
t('C1. a line comment preceded by a QUOTE is stripped (the proven false-green)', () => {
  const code = stripComments(C1, { lang: 'svelte' });
  assert.ok(!/data\s*\??\.\s*unreachable/.test(code), 'the comment still satisfies the `unreachable` read assert');
  assert.ok(!/=\s*'unreachable'/.test(code), "the comment still satisfies the `= 'unreachable'` assert");
  assert.ok(has(code, '_hint'), 'the live declaration must survive');
  assert.ok(has(code, '"handle check"'), 'the string literal must survive');
});

// ── C2 — comment markers inside LITERALS are code, not comments ─────────────
t('C2a. `//` inside a string / template / regex literal is NOT a comment', () => {
  const src = [
    "const url = 'https://example.com/a';",
    'const tpl = `see //docs for from_handle: requireSelfHandle()`;',
    'const re = /a\\/\\/b/;',
    'const div = a / b; const div2 = (x) / 2;',
  ].join('\n');
  const code = stripComments(src);
  assert.strictEqual(code, src, 'nothing here is a comment; the source must come back byte-identical');
});
t('C2b. `/*` inside a string does NOT open a block comment (the OVER-strip direction)', () => {
  const src = [
    "const open = '/*';",
    'const live = { from_handle: requireSelfHandle() };',
    "const close = '*/';",
  ].join('\n');
  const code = stripComments(src);
  assert.ok(has(code, 'from_handle: requireSelfHandle()'), 'a live call site was DELETED by the stripper');
});
t('C2c. `<!--` inside a string does NOT open an HTML comment', () => {
  const src = '<script>\nconst a = "<!--"; const live = 1; const b = "-->";\n</script>';
  const code = stripComments(src, { lang: 'svelte' });
  assert.ok(has(code, 'const live = 1'), 'live code was deleted between two string literals');
});
t('C2d. a `//` inside a `${}` interpolation IS a comment (template re-enters JS)', () => {
  const src = 'const s = `a${ b // secret\n }c`;\n';
  const code = stripComments(src);
  assert.ok(!has(code, 'secret'), 'an interpolation comment survived');
  assert.ok(has(code, '`a${'), 'the template must survive');
});

// ── C3 — every real comment form IS stripped ───────────────────────────────
t('C3. html · block · line · css comments are all stripped', () => {
  const src = [
    '<!-- MARKER_HTML -->',
    '<script>',
    '/* MARKER_BLOCK */',
    'const x = 1; // MARKER_LINE',
    '/* multi',
    '   MARKER_MULTI */',
    '</script>',
    '<style>',
    '/* MARKER_CSS */',
    '.a { color: red; }',
    '</style>',
  ].join('\n');
  const code = stripComments(src, { lang: 'svelte' });
  for (const m of ['MARKER_HTML', 'MARKER_BLOCK', 'MARKER_LINE', 'MARKER_MULTI', 'MARKER_CSS']) {
    assert.ok(!has(code, m), `${m} survived stripping`);
  }
  assert.ok(has(code, 'const x = 1;') && has(code, 'color: red'), 'live code must survive');
});
t('C3b. an indented / trailing line comment is stripped (not just line-leading ones)', () => {
  const code = stripComments('  const a = 1;      // MARKER_TRAILING\n');
  assert.ok(!has(code, 'MARKER_TRAILING') && has(code, 'const a = 1;'));
});

// ── C4 — unterminated comments fail CLOSED (stripped to EOF) ────────────────
t('C4a. an unterminated <!-- is stripped to EOF', () => {
  const code = stripComments('<!-- MARKER_A\nMARKER_B\n', { lang: 'svelte' });
  assert.ok(!has(code, 'MARKER_A') && !has(code, 'MARKER_B'));
});
t('C4b. an unterminated /* is stripped to EOF', () => {
  const code = stripComments('/* MARKER_A\nMARKER_B\n');
  assert.ok(!has(code, 'MARKER_A') && !has(code, 'MARKER_B'));
});

// ── C5 — blanking, not deleting: offsets and lines are preserved ───────────
t('C5. output length + line count are IDENTICAL to input (/m anchors stay honest)', () => {
  const src = '<!-- a -->\n<script>\nconst x = 1; // b\n/* c\n d */\nconst y = 2;\n</script>\n';
  const code = stripComments(src, { lang: 'svelte' });
  assert.strictEqual(code.length, src.length, 'byte offsets shifted');
  assert.strictEqual(code.split('\n').length, src.split('\n').length, 'line numbers shifted');
  // a trailing comment leaves the statement still anchorable at end-of-line
  assert.ok(/const x = 1;[ \t]*$/m.test(code), 'an end-anchored assert broke after stripping');
});

// ── C6 — ⭐ the OLD implementation FAILS this suite ─────────────────────────
// Without this, the suite could be passing for reasons unrelated to the fix.
t('C6. the OLD regex chain fails C1/C2b/C2c — the suite actually bites', () => {
  const old1 = OLD_REGEX_CHAIN(C1);
  assert.ok(/data\s*\??\.\s*unreachable/.test(old1),
    'expected the old chain to LEAVE the quote-preceded comment (the reproduced hole)');
  const old2 = OLD_REGEX_CHAIN("const open = '/*';\nconst live = { from_handle: requireSelfHandle() };\nconst close = '*/';");
  assert.ok(!has(old2, 'from_handle: requireSelfHandle()'),
    'expected the old chain to DELETE the live call site between two string literals');
});

// ── C8 — ⭐ SVELTE BLOCK-CLOSE TAGS (a real bug this suite did not catch) ────
// Found by falsification during review of this very change, and it was the UNDER-strip
// direction again: `{` in markup opened a JS frame, so `{/if}` put the `/` in regex-literal
// position → `/if}` scanned as a regex to end-of-line → the `}` that pops the frame was
// EATEN → every following line stayed in "JS" mode → `<!-- … -->` was no longer stripped at
// all. Every .svelte file verify:handle §15 reads is full of `{#if}…{/if}`, so this silently
// re-opened the hole one block-tag along. C3 missed it because its fixture had no block tags.
t('C8. a `{/if}` / `{/each}` close tag does not swallow the rest of the file', () => {
  for (const close of ['{/if}', '{/each}', '{/await}', '{/key}', '{/snippet}']) {
    const src = `{#if a}\n<p>x</p>\n${close}\n<!-- MARKER_AFTER_${close.slice(2, -1)} -->\n<b>live</b>\n`;
    const code = stripComments(src, { lang: 'svelte' });
    assert.ok(!has(code, 'MARKER_AFTER'), `an HTML comment after ${close} survived stripping`);
    assert.ok(has(code, '<b>live</b>'), `${close} ate live markup`);
  }
  // …and an expression that legitimately contains a division still works.
  const div = stripComments('{#if a/2 > 1}{/if}\n<!-- MARKER_DIV -->\n', { lang: 'svelte' });
  assert.ok(!has(div, 'MARKER_DIV'), 'a division inside a block-open expression broke the scan');
});

// ── C7 — language inference ─────────────────────────────────────────────────
t('C7. langOf maps the extensions the gates actually read', () => {
  assert.strictEqual(langOf('a/b/C.svelte'), 'svelte');
  assert.strictEqual(langOf('src/db/connections.js'), 'js');
  assert.strictEqual(langOf('x.mjs'), 'js');
  assert.strictEqual(langOf('x.css'), 'css');
  assert.strictEqual(langOf('Makefile'), 'js', 'unknown extensions fall back to js');
  assert.ok(!stripCommentsFor('x.svelte', '<!-- MARKER -->').includes('MARKER'));
});

const fail = ledger.filter((x) => !x).length;
console.log(`\n${ledger.length - fail} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
