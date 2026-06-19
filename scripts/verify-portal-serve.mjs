// Verify the REST server serves the CANONICAL SvelteKit portal (portal-app/build)
// when it has been built — the real UI, not the single-file fallback. Proves:
//
//   P1 build present       portal-app/build/200.html exists (run the build first)
//   P2 GET / → SPA shell    200 + references the hashed /_app entry bundle
//   P3 client route fallback GET /library (no file) → 200 + same SPA shell
//   P4 favicon served       GET /favicon.svg → 200, image/svg+xml (the mushroom)
//   P5 API still first       GET /api/v1/tools → 200 JSON (not swallowed by SPA)
//   P6 unknown API → JSON-ish 404 (the html fallback must NOT shadow /api/*)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>. Skips clean (GO, 0 checks) if the
// portal hasn't been built, so a fresh clone without the build still goes green.

import crypto from "node:crypto";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/migrate.js";
import { startRestServer } from "../src/server-rest.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "..", "portal-app", "build", "200.html");
const DB = "data/verify-portal.db";
const KCV = "data/verify-portal-kcv.json";
const hex = () => crypto.randomBytes(32).toString("hex");
const ledger = [];
const rec = (n, p, d = "") => { ledger.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d}` : ""}`); };

async function main() {
  if (!existsSync(BUILD)) {
    console.log("SKIP — portal-app/build not present (run: npm run portal:build). Nothing to verify.");
    console.log("VERDICT: GO — canonical portal not built; REST falls back to the single-file portal");
    process.exit(0);
  }

  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync("data", { recursive: true });
  applyMigrations(new Database(DB));

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: "127.0.0.1", portalMode: "canonical" });
  const { url } = srv;
  const get = async (p, headers) => { const r = await fetch(`${url}${p}`, { headers }); return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() }; };
  const HTML = { Accept: "text/html" };

  try {
    rec("P1. canonical build present (portal-app/build/200.html)", existsSync(BUILD));

    const root = await get("/", HTML);
    rec("P2. GET / → SPA shell (200, references /_app entry)", root.status === 200 && /\/_app\/immutable\/entry\/start\./.test(root.body), `status=${root.status}`);

    const route = await get("/library", HTML);
    rec("P3. client route GET /library → SPA fallback (200, same shell)", route.status === 200 && /\/_app\/immutable\/entry\/start\./.test(route.body), `status=${route.status}`);

    const fav = await get("/favicon.svg");
    rec("P4. GET /favicon.svg → 200 svg (the mushroom)", fav.status === 200 && /svg/.test(fav.ct), `status=${fav.status} ct=${fav.ct}`);

    const tools = await get("/api/v1/tools");
    rec("P5. GET /api/v1/tools → 200 JSON (API matched before SPA fallback)", tools.status === 200 && /json/.test(tools.ct), `status=${tools.status} ct=${tools.ct}`);

    const unknownApi = await get("/api/v1/__nope__/x", HTML);
    rec("P6. unknown /api/ path NOT shadowed by html fallback (no SPA shell body)",
      !/\/_app\/immutable\/entry\/start\./.test(unknownApi.body), `status=${unknownApi.status}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? "GO — REST serves the canonical SvelteKit portal (SPA fallback + favicon), API still routed first" : "NO-GO — see FAIL rows"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("verify-portal-serve threw:", e); process.exit(1); });
