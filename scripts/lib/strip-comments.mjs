// scripts/lib/strip-comments.mjs — THE ONE comment stripper for the verify gates.
//
// ⚠️ WHY THIS EXISTS. Source-reading gates assert against CODE, never prose: the
// recurring failure in this repo is "a gate COMMENT launders the bug it describes"
// (verify:handle §15, verify:intelligence-screen S8, verify:narrate-device-claim D8
// all carry that scar). Every one of them stripped comments with a chain of regexes
// like:
//
//     s.replace(/<!--[\s\S]*?-->/g, '')
//      .replace(/\/\*[\s\S]*?\*\//g, '')
//      .replace(/(^|[^:"'`\\])\/\/.*$/gm, '$1')
//
// A regex cannot know whether a `//` is a comment or the middle of a string, so that
// chain is wrong in BOTH directions and each direction is a false GREEN:
//
//   • UNDER-STRIP → prose satisfies a positive assert. `const s = "x"// data?.unreachable`
//     survives (the char before `//` is a quote, excluded by the class), so a comment
//     can satisfy `/data\s*\??\.\s*unreachable/`. PROVEN: deleting the live
//     `else if (data?.unreachable)` from ProfileView.svelte and leaving that one comment
//     behind kept verify:handle at `85 pass · 0 fail · VERDICT: GO`.
//   • OVER-STRIP → real code vanishes and a NEGATIVE assert (`ok(!/…/.test(code))`, or a
//     `assigns.length === guarded.length` balance) goes green because the offending line
//     was deleted by the stripper. A string containing `/*` swallows everything up to the
//     next `*/` — including live call sites.
//
// CodeQL flags the chain as js/incomplete-multi-character-sanitization. It is dev-only
// tooling with no untrusted input, so it is not a vulnerability — but it IS a gate-integrity
// hole, and the fix is not another regex layer. It is a scanner that knows what a string is.
//
// WHAT THIS DOES. A single-pass character scanner (no regex, no backtracking) that tracks
// lexical context — markup / JS / CSS, and inside JS: single-quoted, double-quoted and
// template strings (with `${}` re-entry), and regex literals. Only a `//`, `/* */` or
// `<!-- -->` reached in a CODE context is a comment.
//
// COMMENT BYTES ARE BLANKED, NOT DELETED. Each stripped character becomes a space and every
// newline is preserved, so byte offsets and line numbers are IDENTICAL to the input. That
// keeps `^`/`$` (`/m`) anchors in the calling gate honest and makes a reported line number
// point at the real line. (The old chain deleted, which silently shifted every anchor.)

import { readFileSync } from 'node:fs';

const isIdentChar = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$';

// A `/` starts a REGEX LITERAL rather than a division when the previous significant token
// cannot end an expression. Keyword-aware, because `return /x/` and `a / b` differ only by
// what came before. Guessing wrong the "regex" way could swallow live code, so this is
// deliberately conservative: an identifier / number / `)` / `]` / `}` means DIVISION.
const REGEX_OK_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await', 'default',
]);

function regexAllowedAt(src, i) {
  let j = i - 1;
  // skip back over whitespace (comments are already blanked to spaces by the time we look back)
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j--;
  if (j < 0) return true;
  const c = src[j];
  if (c === ')' || c === ']') return false;          // (a+b) / 2 · arr[0] / 2
  if (c === '}') return true;                        // block end: `if (x) {} /re/.test(y)` — safe side
  if (isIdentChar(c)) {
    let k = j;
    while (k >= 0 && isIdentChar(src[k])) k--;
    const word = src.slice(k + 1, j + 1);
    if (/^[0-9]/.test(word)) return false;           // numeric literal → division
    return REGEX_OK_KEYWORDS.has(word);              // identifier → division; keyword → regex
  }
  return true;                                       // operator / punctuation → regex position
}

/**
 * @param {string} source
 * @param {{ lang?: 'js'|'ts'|'svelte'|'html'|'css' }} [opts]
 * @returns {string} same length as `source`, comment bytes replaced by spaces
 */
export function stripComments(source, opts = {}) {
  const src = String(source ?? '');
  const lang = opts.lang || 'js';
  const out = src.split('');
  const n = src.length;

  // Blank [a, b) — keep newlines so line numbers and /m anchors survive.
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };

  // Mode stack. 'markup' = HTML/Svelte template · 'js' · 'css' · 'template' (a `…`
  // string literal, which is a MODE and not a skip because `${ … }` re-enters JS and a
  // `//` inside that interpolation IS a comment).
  // A js frame records how it ends: a `</script>` tag, a `}` at depth 0 (a Svelte `{…}`
  // markup expression or a `${}` interpolation), or EOF (a plain .js file).
  const startMode = (lang === 'svelte' || lang === 'html') ? 'markup' : (lang === 'css' ? 'css' : 'js');
  /** @type {Array<{mode:string, end:'script'|'style'|'brace'|'eof', depth:number}>} */
  const stack = [{ mode: startMode, end: 'eof', depth: 0 }];
  const top = () => stack[stack.length - 1];

  let i = 0;
  while (i < n) {
    const frame = top();
    const c = src[i];

    if (frame.mode === 'markup') {
      if (c === '<') {
        if (src.startsWith('<!--', i)) {
          const close = src.indexOf('-->', i + 4);
          const end = close === -1 ? n : close + 3;   // unterminated <!-- comments to EOF
          blank(i, end); i = end; continue;
        }
        const tag = /^<(script|style)\b[^>]*>/i.exec(src.slice(i, i + 400));
        if (tag) {
          i += tag[0].length;
          stack.push({ mode: tag[1].toLowerCase() === 'script' ? 'js' : 'css', end: tag[1].toLowerCase() === 'script' ? 'script' : 'style', depth: 0 });
          continue;
        }
        i++; continue;
      }
      if (c === '{') {
        // ⚠️ A Svelte BLOCK-CLOSE tag (`{/if}`, `{/each}`, `{/await}`, `{/key}`, `{/snippet}`)
        // is NOT an expression. Treating it as one is a live false-green: the `/` lands in
        // regex-literal position, so `/if}` scans as a regex to end-of-line, EATS the `}`
        // that would pop the frame, and every following line stays in "JS" mode — after which
        // `<!-- … -->` in the markup is no longer stripped at all. Found by falsification
        // against a `{#if}…{/if}` fixture; C8 in verify:strip-comments is that fixture.
        // Close tags carry no JS, so skip the whole tag literally.
        if (src[i + 1] === '/') {
          const close = src.indexOf('}', i + 1);
          i = close === -1 ? n : close + 1;
          continue;
        }
        stack.push({ mode: 'js', end: 'brace', depth: 0 });   // a real `{expr}` → JS
        i++; continue;
      }
      i++; continue;
    }

    if (frame.mode === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ mode: 'js', end: 'template', depth: 0 }); i += 2; continue; }
      i++; continue;
    }

    if (frame.mode === 'css') {
      if (frame.end === 'style' && src.startsWith('</style', i)) { stack.pop(); i += 7; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2);
        const end = close === -1 ? n : close + 2;
        blank(i, end); i = end; continue;
      }
      if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
      i++; continue;
    }

    // ── JS ────────────────────────────────────────────────────────────────────
    if (frame.end === 'script' && (c === '<' && src.startsWith('</script', i))) { stack.pop(); i += 8; continue; }

    if (c === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end); i = end; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") { i = skipString(src, i, c); continue; }
    if (c === '`') { stack.push({ mode: 'template', end: 'backtick', depth: 0 }); i++; continue; }
    if (c === '/' && regexAllowedAt(src, i)) { i = skipRegex(src, i); continue; }
    if (c === '{') { frame.depth++; i++; continue; }
    if (c === '}') {
      if (frame.end === 'brace' && frame.depth === 0) { stack.pop(); i++; continue; }
      if (frame.end === 'template' && frame.depth === 0) { stack.pop(); i++; continue; }
      frame.depth--; i++; continue;
    }
    i++;
  }

  return out.join('');
}

// `i` points at the opening quote; returns the index just past the closing quote.
// An unterminated string ends at the newline (JS forbids a raw newline in '…'/"…"),
// which keeps one bad quote from swallowing the rest of the file.
function skipString(src, i, quote) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    if (c === '\n') return j;          // unterminated → resync at the line break
    j++;
  }
  return src.length;
}

// Regex literal: /…/flags, honoring escapes and character classes ([/] is not a
// terminator). Bails at a newline — an unterminated regex is a division we misread,
// and resyncing beats eating the file.
function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return j;
    if (inClass) { if (c === ']') inClass = false; j++; continue; }
    if (c === '[') { inClass = true; j++; continue; }
    if (c === '/') { j++; while (j < src.length && /[a-z]/i.test(src[j])) j++; return j; }
    j++;
  }
  return src.length;
}

const EXT_LANG = {
  '.svelte': 'svelte', '.html': 'html', '.htm': 'html', '.css': 'css',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts', '.jsx': 'js', '.tsx': 'ts',
};

/** Infer the language from a file path (default 'js'). */
export function langOf(filePath) {
  const p = String(filePath || '');
  const dot = p.lastIndexOf('.');
  return (dot === -1 ? null : EXT_LANG[p.slice(dot).toLowerCase()]) || 'js';
}

/** stripComments() with the language inferred from `filePath`. */
export function stripCommentsFor(filePath, source) {
  return stripComments(source, { lang: langOf(filePath) });
}

/** readFileSync + stripCommentsFor — the shape most gates want. */
export function readCode(filePath) {
  return stripCommentsFor(filePath, readFileSync(filePath, 'utf8'));
}
