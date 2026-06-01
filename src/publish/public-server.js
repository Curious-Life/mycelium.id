// src/publish/public-server.js — the PUBLIC-facing surface (separate from the
// private portal). This is the only server meant to be reachable from the
// internet (point your custom domain / tunnel at it). It is fail-closed by
// construction:
//
//   GET /p/:slug          → serve IFF the doc is published=1 (public).      else 404
//   GET /s/:slug?t=<tok>  → serve IFF the signed capability token is valid. else 404
//   anything else         → 404
//
// It NEVER exposes the tool API, the private portal, or any doc that the owner
// has not explicitly made public/unlisted. A guessed or private slug, a missing
// or forged token, an expired token → 404 (we don't even reveal existence).
// Content is rendered on demand from the (decrypted-at-read) document row and
// HTML-escaped before any markdown formatting.

import express from "express";
import { boot } from "../index.js";
import { createIdentity } from "../identity/identity.js";
import { verifyLink } from "./links.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** Escape FIRST, then apply a tiny safe markdown subset. No raw HTML survives. */
function renderMarkdown(src) {
  const lines = esc(src ?? "").split("\n");
  let html = "", inList = false;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  for (const ln of lines) {
    const h = ln.match(/^(#{1,3})\s+(.*)$/), li = ln.match(/^\s*[-*]\s+(.*)$/);
    if (h) { if (inList) { html += "</ul>"; inList = false; } html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; }
    else if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; }
    else if (ln.trim() === "") { if (inList) { html += "</ul>"; inList = false; } }
    else { if (inList) { html += "</ul>"; inList = false; } html += `<p>${inline(ln)}</p>`; }
  }
  if (inList) html += "</ul>";
  return html;
}

function page({ title, body, handle }) {
  const by = handle ? `<footer>published by <strong>@${esc(handle)}</strong> · mycelium</footer>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title || "Mycelium")}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>:root{--bg:#0A0A0C;--surface:#141417;--ink:#E8E8EC;--muted:#9898A3;--accent:#5B9FE8;--line:#2A2A32}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 'Geist',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.doc{max-width:720px;margin:0 auto;padding:64px 24px}h1,h2,h3{color:#fff;font-weight:600;line-height:1.3;margin:1.4em 0 .5em}h1{font-size:30px;margin-top:0}
a{color:var(--accent)}code{font:14px 'JetBrains Mono',monospace;background:var(--surface);padding:2px 6px;border-radius:4px;color:var(--accent)}
p{margin:.9em 0}ul{padding-left:22px}footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}</style>
</head><body><article class="doc">${body}${by}</article></body></html>`;
}

/**
 * Boot the public server. Reuses boot() for the (decrypting) db; serves only
 * published/unlisted docs. Binds localhost by default — point your tunnel/domain
 * at MYCELIUM_PUBLIC_HOST:MYCELIUM_PUBLIC_PORT.
 */
export async function startPublicServer({ dbPath, kcvPath, userHex, systemHex, userId, handle, port = 0, host = "127.0.0.1" } = {}) {
  const bootOpts = {};
  for (const [k, v] of Object.entries({ dbPath, kcvPath, userHex, systemHex, userId })) if (v !== undefined) bootOpts[k] = v;
  const { db, close, userId: owner } = await boot(bootOpts);
  const identity = createIdentity({ masterHex: process.env.ENCRYPTION_MASTER_KEY, handle: handle ?? process.env.MYCELIUM_HANDLE ?? null });

  const app = express();
  app.disable("x-powered-by");

  const serveDoc = (res, doc) => {
    res.status(200).type("html").send(page({ title: doc.title, body: renderMarkdown(doc.content), handle: identity.handle }));
  };
  const notFound = (res) => res.status(404).type("html").send(page({ title: "Not found", body: "<h1>404</h1><p>Nothing here.</p>" }));

  // Public: only when published=1.
  app.get("/p/:slug", async (req, res) => {
    try {
      const doc = await db.documents.getBySlug(owner, req.params.slug);
      if (doc && doc.published === 1) return serveDoc(res, doc);
    } catch { /* fall through to 404 */ }
    notFound(res);
  });

  // Unlisted: only with a valid signed capability token bound to this slug.
  app.get("/s/:slug", async (req, res) => {
    try {
      const v = verifyLink(identity, String(req.query.t || ""), { slug: req.params.slug });
      if (v.valid) {
        const doc = await db.documents.getBySlug(owner, req.params.slug);
        if (doc) return serveDoc(res, doc);
      }
    } catch { /* fall through */ }
    notFound(res);
  });

  // Everything else (incl. the API surface, the root, traversal attempts) → 404.
  app.use((_req, res) => notFound(res));

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on("error", reject);
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  return { app, server, db, close, identity, url: `http://${host}:${boundPort}`, port: boundPort, host };
}

async function main() {
  const port = Number(process.env.MYCELIUM_PUBLIC_PORT ?? 8788);
  const host = process.env.MYCELIUM_PUBLIC_HOST ?? "127.0.0.1";
  const { url, server, close, identity } = await startPublicServer({ port, host });
  process.stderr.write(`mycelium PUBLIC surface on ${url} — serves ONLY published/unlisted docs (handle: ${identity.handle ?? "unset"})\n`);
  const shutdown = () => server.close(() => { try { close?.(); } finally { process.exit(0); } });
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { process.stderr.write(`fatal: ${String(err?.message ?? err)}\n`); process.exit(1); });
}
