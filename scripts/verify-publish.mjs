// Verify the publishing foundation: identity (ed25519 from master key), signed
// capability links, and the FAIL-CLOSED public server. The headline guarantee:
// a private/unpublished doc is NEVER served, even with a guessed slug or a
// forged/expired/mismatched token.
//
//   Identity:  I1 deterministic  I2 sign/verify  I3 tamper rejected
//              I4 verifyWithPublicKey  I5 invalid handle rejected
//   Links:     L1 mint+verify  L2 tampered payload  L3 expired  L4 slug-mismatch
//              L5 forged signature
//   Server:    S1 public doc served at /p/:slug         S2 unlisted NOT at /p/
//              S3 unlisted served at /s/:slug?t=valid    S4 bad token → 404
//              S5 no token → 404   S6 token for another slug → 404
//              S7 private/unpublished slug → 404         S8 /, /api/v1/* → 404
//              S9 LEAKAGE: private content never appears in ANY response
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from "node:crypto";
import { rmSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/migrate.js";
import { createIdentity, verifyWithPublicKey, isValidHandle } from "../src/identity/identity.js";
import { mintLink, verifyLink } from "../src/publish/links.js";
import { startPublicServer } from "../src/publish/public-server.js";

const DB = "data/verify-publish.db";
const KCV = "data/verify-publish-kcv.json";
const USER = "local-user";
const hex = () => crypto.randomBytes(32).toString("hex");
const ledger = [];
const rec = (n, p, d = "") => { ledger.push(p); console.log(`${p ? "PASS" : "FAIL"}  ${n}${d ? `\n      ${d}` : ""}`); };

const PRIVATE_SECRET = "PRIVATE_C_SECRET_donotleak_42";

async function main() {
  // ── Identity ──────────────────────────────────────────────────────────
  const master = hex();
  const id = createIdentity({ masterHex: master, handle: "martin" });
  const id2 = createIdentity({ masterHex: master, handle: "martin" });
  rec("I1. identity is deterministic from the master key", id.publicKeyB64 === id2.publicKeyB64);
  const sig = id.sign("publish:notes/forest.md");
  rec("I2. sign → verify round-trips", id.verify("publish:notes/forest.md", sig) === true);
  rec("I3. tampered message rejected", id.verify("publish:OTHER", sig) === false);
  rec("I4. verifyWithPublicKey (no private key) verifies", verifyWithPublicKey(id.publicKeyB64, "publish:notes/forest.md", sig) === true
    && verifyWithPublicKey(id.publicKeyB64, "x", sig) === false);
  let badHandle = false; try { createIdentity({ masterHex: master, handle: "Bad Handle!" }); } catch { badHandle = true; }
  rec("I5. invalid handle rejected", badHandle && isValidHandle("martin") && !isValidHandle("a"));

  // ── Signed links ──────────────────────────────────────────────────────
  const tok = mintLink(id, { slug: "forest" });
  rec("L1. mint + verify a link for its slug", verifyLink(id, tok, { slug: "forest" }).valid === true);
  const parts = tok.split("."); const tampered = `${Buffer.from(JSON.stringify({ slug: "evil", exp: 0 })).toString("base64url")}.${parts[1]}`;
  rec("L2. tampered payload rejected (bad signature)", verifyLink(id, tampered).valid === false);
  const expired = mintLink(id, { slug: "forest", ttlSec: 10, now: 1000 });
  rec("L3. expired token rejected", verifyLink(id, expired, { now: 2000 }).valid === false);
  rec("L4. token for slug A rejected when slug B requested", verifyLink(id, tok, { slug: "other" }).valid === false);
  const otherId = createIdentity({ masterHex: hex() });
  rec("L5. token signed by a different key rejected", verifyLink(otherId, tok, { slug: "forest" }).valid === false);

  // ── Fail-closed public server ───────────────────────────────────────────
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync("data", { recursive: true });
  applyMigrations(new Database(DB));

  const userHex = hex();
  const srv = await startPublicServer({ dbPath: DB, kcvPath: KCV, userHex, systemHex: hex(), handle: "martin", port: 0, host: "127.0.0.1" });
  const { db, url, identity } = srv;
  try {
    // Seed: A public, B unlisted (slug, not published), C private (slug, not published, no link).
    await db.documents.upsert({ user_id: USER, path: "notes/a.md", title: "Public A", content: "PUBLIC_A_BODY about forests" });
    await db.documents.publish(USER, "notes/a.md", "a-pub");
    await db.documents.upsert({ user_id: USER, path: "notes/b.md", title: "Unlisted B", content: "UNLISTED_B_BODY hidden notes" });
    await db.documents.setPublicSlug(USER, "notes/b.md", "b-unl");
    await db.documents.upsert({ user_id: USER, path: "notes/c.md", title: "Private C", content: PRIVATE_SECRET });
    await db.documents.setPublicSlug(USER, "notes/c.md", "c-prv");

    const bTok = mintLink(identity, { slug: "b-unl" });
    const get = async (p) => { const r = await fetch(`${url}${p}`); return { status: r.status, body: await r.text() }; };

    const a = await get("/p/a-pub");
    rec("S1. public doc served at /p/:slug", a.status === 200 && a.body.includes("PUBLIC_A_BODY"), `status=${a.status}`);
    const bPub = await get("/p/b-unl");
    rec("S2. unlisted doc NOT served at /p/:slug", bPub.status === 404 && !bPub.body.includes("UNLISTED_B_BODY"), `status=${bPub.status}`);
    const bUnl = await get(`/s/b-unl?t=${encodeURIComponent(bTok)}`);
    rec("S3. unlisted doc served at /s/:slug with a valid token", bUnl.status === 200 && bUnl.body.includes("UNLISTED_B_BODY"), `status=${bUnl.status}`);
    const bBad = await get(`/s/b-unl?t=${encodeURIComponent(bTok)}TAMPER`);
    rec("S4. unlisted with a bad token → 404", bBad.status === 404 && !bBad.body.includes("UNLISTED_B_BODY"));
    const bNo = await get("/s/b-unl");
    rec("S5. unlisted with no token → 404", bNo.status === 404 && !bNo.body.includes("UNLISTED_B_BODY"));
    const cWithB = await get(`/s/c-prv?t=${encodeURIComponent(bTok)}`);
    rec("S6. token bound to slug B cannot open slug C → 404", cWithB.status === 404 && !cWithB.body.includes(PRIVATE_SECRET));
    const cPub = await get("/p/c-prv");
    rec("S7. private/unpublished slug → 404", cPub.status === 404 && !cPub.body.includes(PRIVATE_SECRET));
    const root = await get("/"); const api = await get("/api/v1/tools"); const trav = await get("/../package.json");
    rec("S8. /, /api/v1/*, traversal → 404 (no API/portal/file exposure)",
      root.status === 404 && api.status === 404 && trav.status === 404);

    // S9 — the headline: private content appears in NONE of the responses above.
    const all = [a, bPub, bUnl, bBad, bNo, cWithB, cPub, root, api, trav].map((r) => r.body).join("\n");
    rec("S9. LEAKAGE GUARD: private doc content never appears in any response", !all.includes(PRIVATE_SECRET));
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? "GO — identity + signed links + fail-closed public server (private content never served)" : "NO-GO — see FAIL rows"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("verify-publish threw:", e); process.exit(1); });
