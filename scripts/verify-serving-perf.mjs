// verify:serving-perf — the portal static-delivery surface (src/serving.js):
//   S1 hashed immutable asset + Accept-Encoding:br → serves the .br sibling,
//      Content-Encoding:br, Cache-Control immutable, bytes == the .br file
//   S2 same + Accept-Encoding:gzip → serves the .gz sibling
//   S3 same + NO Accept-Encoding → raw bytes, still Cache-Control immutable
//   S4 the SPA shell (.html) stays Cache-Control:no-store (never pinned)
//   S5 a large /portal JSON response IS gzip-compressed (the data-fetch win)
//   S6 an SSE response (text/event-stream) is NEVER compressed (no buffering)
//   S7 an /auth response is NEVER compressed (no token size-oracle)
//   S8 server-rest.js wires it: compression first, precompressed before static
//
// Tests the middleware in isolation against a fixture build (the real build is
// gitignored output) + a source assertion for the wiring. Uses raw node:http so
// Content-Encoding is observable (fetch auto-decodes and strips it).
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import http from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import express from 'express';
import { precompressedStatic, setStaticHeaders, compressionMiddleware } from '../src/serving.js';

const BUILD = 'data/verify-serving-build';
const ASSET = '/_app/immutable/chunks/app.ABC123.js';
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// raw GET — does NOT send Accept-Encoding unless asked, does NOT auto-decode.
function get(base, p, encoding) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (encoding) headers['Accept-Encoding'] = encoding;
    http.get(`${base}${p}`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

async function main() {
  // Fixture build: one hashed immutable asset (+ .br/.gz siblings) and a shell.
  try { rmSync(BUILD, { recursive: true, force: true }); } catch {}
  mkdirSync(`${BUILD}/_app/immutable/chunks`, { recursive: true });
  const rawJs = Buffer.from(`console.log(${JSON.stringify('z'.repeat(4000))});`);
  writeFileSync(`${BUILD}${ASSET}`, rawJs);
  const brBytes = brotliCompressSync(rawJs);
  const gzBytes = gzipSync(rawJs);
  writeFileSync(`${BUILD}${ASSET}.br`, brBytes);
  writeFileSync(`${BUILD}${ASSET}.gz`, gzBytes);
  writeFileSync(`${BUILD}/200.html`, '<!doctype html><title>shell</title>');

  const app = express();
  app.use(compressionMiddleware());
  app.get('/portal/big', (req, res) => res.json({ data: 'y'.repeat(5000) })); // > 1KB threshold
  app.get('/portal/sse', (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(`data: ${'q'.repeat(5000)}\n\n`); res.end(); });
  app.get('/auth/big', (req, res) => res.json({ token: 'z'.repeat(5000) }));
  app.use(precompressedStatic(BUILD));
  app.use(express.static(BUILD, { setHeaders: setStaticHeaders }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const br = await get(base, ASSET, 'br');
    rec('S1. immutable asset + br → .br sibling, immutable cache, exact bytes',
      br.status === 200 && br.headers['content-encoding'] === 'br'
        && /immutable/.test(br.headers['cache-control'] || '') && br.body.equals(brBytes)
        && (br.headers['content-type'] || '').includes('javascript'),
      `enc=${br.headers['content-encoding']} cc=${br.headers['cache-control']} bytesOk=${br.body.equals(brBytes)}`);

    const gz = await get(base, ASSET, 'gzip');
    rec('S2. immutable asset + gzip → .gz sibling',
      gz.status === 200 && gz.headers['content-encoding'] === 'gzip' && gz.body.equals(gzBytes),
      `enc=${gz.headers['content-encoding']} bytesOk=${gz.body.equals(gzBytes)}`);

    const raw = await get(base, ASSET, null);
    rec('S3. immutable asset + no Accept-Encoding → raw bytes, still immutable',
      raw.status === 200 && !raw.headers['content-encoding']
        && /immutable/.test(raw.headers['cache-control'] || '') && raw.body.equals(rawJs),
      `enc=${raw.headers['content-encoding']} cc=${raw.headers['cache-control']}`);

    const shell = await get(base, '/200.html', 'br');
    rec('S4. SPA shell (.html) stays no-store, never immutable',
      /no-store/.test(shell.headers['cache-control'] || '') && !/immutable/.test(shell.headers['cache-control'] || ''),
      `cc=${shell.headers['cache-control']}`);

    const big = await get(base, '/portal/big', 'gzip');
    rec('S5. large /portal JSON is gzip-compressed (the data-fetch win)',
      big.status === 200 && big.headers['content-encoding'] === 'gzip',
      `enc=${big.headers['content-encoding']}`);

    const sse = await get(base, '/portal/sse', 'gzip');
    rec('S6. SSE (text/event-stream) is NEVER compressed',
      sse.status === 200 && !sse.headers['content-encoding'] && (sse.headers['content-type'] || '').includes('event-stream'),
      `enc=${sse.headers['content-encoding']} ct=${sse.headers['content-type']}`);

    const auth = await get(base, '/auth/big', 'gzip');
    rec('S7. /auth response is NEVER compressed (no token size-oracle)',
      auth.status === 200 && !auth.headers['content-encoding'],
      `enc=${auth.headers['content-encoding']}`);

    // S8: the wiring in server-rest.js — order matters (compression outermost,
    // precompressed before static, setStaticHeaders applied).
    const src = readFileSync('src/server-rest.js', 'utf8');
    const iComp = src.indexOf('compressionMiddleware()');
    const iPre = src.indexOf('precompressedStatic(CANONICAL_BUILD)');
    const iStatic = src.indexOf('express.static(CANONICAL_BUILD');
    rec('S8. server-rest wires compression first + precompressed before static',
      iComp > 0 && iPre > 0 && iStatic > 0 && iComp < iPre && iPre < iStatic
        && /setHeaders:\s*setStaticHeaders/.test(src),
      `comp@${iComp} pre@${iPre} static@${iStatic}`);
  } finally {
    server.close();
    try { rmSync(BUILD, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — precompressed static + immutable cache + dynamic compression (SSE/auth excluded)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
