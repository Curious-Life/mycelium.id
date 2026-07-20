// Verify — the Library SVG sanitizer strips every script/handler/external-ref
// vector before an untrusted SVG is rendered (R4-SVGRENDER, security gate).
//
// SVG is rendered via <img> (a sanitized data URL) so scripts can't execute in
// any browser; this gate proves the SECOND layer — sanitizeSvg() removes
// <script>/<foreignObject>, on*-handlers, javascript: URLs, and EXTERNAL
// references (only in-document #fragment refs survive, so a malicious SVG can't
// phone home even in an <img>). preview.ts is TypeScript in the portal app, so
// we transpile it with esbuild and run it under jsdom (both resolved from
// portal-app/node_modules — installed wherever the portal is built).
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portalRequire = createRequire(path.join(repoRoot, 'portal-app', 'package.json'));
const esbuild = portalRequire('esbuild');
const { JSDOM } = portalRequire('jsdom');

// Provide a DOM so the browser-only sanitizer runs under Node.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
globalThis.document = dom.window.document;

// Transpile preview.ts → a temp .mjs and import it.
const srcTs = readFileSync(path.join(repoRoot, 'portal-app', 'src', 'lib', 'library', 'preview.ts'), 'utf8');
const { code } = esbuild.transformSync(srcTs, { loader: 'ts', format: 'esm', target: 'es2022' });
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'svg-sanitize-'));
const tmpFile = path.join(tmpDir, 'preview.mjs');
writeFileSync(tmpFile, code);
const { sanitizeSvg, svgToDataUrl, isSvgDoc, fileKind } = await import(`file://${tmpFile}`);

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const clean = (svg) => sanitizeSvg(svg) || '';

// S1 — <script> removed, benign shapes kept.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>');
  rec('S1 <script> stripped, <rect> kept', !/<script/i.test(out) && /<rect/i.test(out), out.slice(0, 120));
}
// S2 — every on* event handler removed.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><rect onclick="x()" onmouseover="y()"/></svg>');
  rec('S2 on*-handlers stripped', !/onload|onclick|onmouseover/i.test(out), out.slice(0, 120));
}
// S3 — external href stripped; in-document #fragment kept.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="http://evil.example/x"/><use xlink:href="#ok"/></svg>');
  rec('S3 external href stripped, #fragment kept', !/evil\.example/i.test(out) && /#ok/.test(out), out.slice(0, 160));
}
// S4 — external <image href> (tracking pixel) stripped.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/track.png" width="1" height="1"/></svg>');
  rec('S4 external <image href> stripped (no phone-home)', !/evil\.example/i.test(out), out.slice(0, 140));
}
// S5 — javascript: URL in any attribute stripped.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>');
  rec('S5 javascript: URL stripped', !/javascript:/i.test(out), out.slice(0, 140));
}
// S6 — <foreignObject> (HTML/script smuggling) removed.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>x()</script></body></foreignObject><rect/></svg>');
  rec('S6 <foreignObject> removed', !/foreignobject|<script/i.test(out) && /<rect/i.test(out), out.slice(0, 140));
}
// S7 — <style> with url()/@import scrubbed of external fetches.
{
  const out = clean('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css); .a{fill:url(https://evil.example/p.png)}</style><rect class="a"/></svg>');
  rec('S7 <style> external url()/@import scrubbed', !/evil\.example/i.test(out), out.slice(0, 160));
}
// S7b — external url() in a PRESENTATION attribute (fill/filter/mask) stripped,
// while a local url(#id) fragment ref survives.
{
  const ext = clean('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/p.png)" filter="url(https://evil.example/f.svg#f)"/></svg>');
  const loc = clean('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>');
  rec('S7b external url() in presentation attr stripped, url(#id) kept',
    !/evil\.example/i.test(ext) && /url\(#g\)/.test(loc), `${ext.slice(0, 100)} | ${loc.slice(0, 100)}`);
}
// S8 — svgToDataUrl yields a data: URL whose payload carries no <script>.
{
  const url = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>');
  const ok = typeof url === 'string' && url.startsWith('data:image/svg+xml') && !/%3Cscript/i.test(url) && !/<script/i.test(decodeURIComponent(url));
  rec('S8 svgToDataUrl → safe data: URL, no <script>', ok, (url || '').slice(0, 80));
}
// S9 — a non-SVG root (HTML) returns null (fail-closed, never rendered as SVG).
{
  rec('S9 non-SVG root → null', sanitizeSvg('<html><body><script>x()</script></body></html>') === null, '');
}
// S10 — helpers classify correctly.
{
  rec('S10 isSvgDoc + fileKind classify',
    isSvgDoc('a/b.svg', null) === true && isSvgDoc(null, '<svg></svg>') === true
      && isSvgDoc('a/b.md', 'plain') === false
      && fileKind('doc.pdf') === 'pdf' && fileKind('p.svg') === 'svg' && fileKind('i.png') === 'image',
    '');
}

rmSync(tmpDir, { recursive: true, force: true });
const ok = ledger.every(Boolean);
console.log(`\nVERDICT: ${ok ? 'GO' : 'NO-GO'} — SVG sanitizer strips scripts/handlers/external-refs before render`);
console.log(`EXIT=${ok ? 0 : 1}`);
process.exit(ok ? 0 : 1);
