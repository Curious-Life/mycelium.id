// Verify the publishing foundation: identity (ed25519 from master key), signed
// capability links, and the FAIL-CLOSED public server. The headline guarantee:
// a private/unpublished doc is NEVER served, even with a guessed slug or a
// forged/expired/mismatched token.
//
//   Identity:  I1 deterministic  I2 sign/verify  I3 tamper rejected
//              I4 verifyWithPublicKey  I5 invalid handle rejected
//   Links:     L1 mint+verify  L2 tampered payload  L3 expired  L4 slug-mismatch
//              L5 forged signature  L6 no-nonce mint rejected  L7 nonce returned
//              L8 non-canonical payload  L9 non-canonical signature
//              L10 nonce-less payload rejected  L11 setPublicSlug → nonce
//   Server:    S1 public doc served at /p/:slug         S2 unlisted NOT at /p/
//              S3 unlisted served at /s/:slug?t=valid    S4 bad token → 404
//              S5 no token → 404   S6 token for another slug → 404
//              S7 private/unpublished slug → 404         S8 /, /api/v1/* → 404
//              S9 LEAKAGE: private content never appears in ANY response
//   Revocation: S10 old token 404 after unpublish (nonce rotated)
//              S11 re-share mints fresh nonce  S12 new works/old dead
//              S13 revokeShareLinks → 404  S13b /p/ 404 after unpublish
//              S14 array ?t → 404  S15 leakage sweep
//              S16 schema interlock: refuse boot without publish_nonce
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
  const tok = mintLink(id, { slug: "forest", nonce: "epoch1" });
  rec("L1. mint + verify a link for its slug", verifyLink(id, tok, { slug: "forest" }).valid === true);
  const parts = tok.split("."); const tampered = `${Buffer.from(JSON.stringify({ slug: "evil", nonce: "epoch1", exp: 0 })).toString("base64url")}.${parts[1]}`;
  rec("L2. tampered payload rejected (bad signature)", verifyLink(id, tampered).valid === false);
  const expired = mintLink(id, { slug: "forest", nonce: "epoch1", ttlSec: 10, now: 1000 });
  rec("L3. expired token rejected", verifyLink(id, expired, { now: 2000 }).valid === false);
  rec("L4. token for slug A rejected when slug B requested", verifyLink(id, tok, { slug: "other" }).valid === false);
  const otherId = createIdentity({ masterHex: hex() });
  rec("L5. token signed by a different key rejected", verifyLink(otherId, tok, { slug: "forest" }).valid === false);
  let noNonce = false; try { mintLink(id, { slug: "forest" }); } catch { noNonce = true; }
  rec("L6. mint without a nonce rejected (cannot mint an unrevocable link)", noNonce);
  rec("L7. verify returns the embedded nonce", verifyLink(id, tok, { slug: "forest" }).nonce === "epoch1");
  // Non-canonical base64url (extra '=' padding) must be rejected (malleability).
  const malleable = `${parts[0]}=.${parts[1]}`;
  rec("L8. non-canonical base64url payload rejected", verifyLink(id, malleable, { slug: "forest" }).valid === false);
  // Non-canonical SIGNATURE (padded) must also be rejected — this is the
  // variant that round-trips through ed25519 verify, so the canonical check is
  // load-bearing here, not just on the payload.
  const malleableSig = `${parts[0]}.${parts[1]}=`;
  rec("L9. non-canonical base64url signature rejected", verifyLink(id, malleableSig, { slug: "forest" }).valid === false);
  // A signed payload with NO nonce (owner could mint a pre-fix token shape) is
  // rejected — proves the nonce type-guard at the verify layer.
  const noNoncePayload = Buffer.from(JSON.stringify({ slug: "forest", exp: 0 })).toString("base64url");
  const noNonceTok = `${noNoncePayload}.${id.sign(noNoncePayload)}`;
  rec("L10. validly-signed but nonce-less payload rejected", verifyLink(id, noNonceTok, { slug: "forest" }).valid === false);

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
    const bRow = await db.documents.setPublicSlug(USER, "notes/b.md", "b-unl");
    await db.documents.upsert({ user_id: USER, path: "notes/c.md", title: "Private C", content: PRIVATE_SECRET });
    const cRow = await db.documents.setPublicSlug(USER, "notes/c.md", "c-prv");

    rec("L11. setPublicSlug returns a publish_nonce (capability epoch)", typeof bRow.publish_nonce === "string" && bRow.publish_nonce.length >= 16);
    const bTok = mintLink(identity, { slug: "b-unl", nonce: bRow.publish_nonce });
    const get = async (p) => { const r = await fetch(`${url}${p}`); return { status: r.status, body: await r.text(), headers: r.headers }; };

    const a = await get("/p/a-pub");
    rec("S1. public doc served at /p/:slug", a.status === 200 && a.body.includes("PUBLIC_A_BODY"), `status=${a.status}`);
    const bPub = await get("/p/b-unl");
    rec("S2. unlisted doc NOT served at /p/:slug", bPub.status === 404 && !bPub.body.includes("UNLISTED_B_BODY"), `status=${bPub.status}`);
    const bUnl = await get(`/s/b-unl?t=${encodeURIComponent(bTok)}`);
    rec("S3. unlisted doc served at /s/:slug with a valid token", bUnl.status === 200 && bUnl.body.includes("UNLISTED_B_BODY"), `status=${bUnl.status}`);
    rec("S3b. unlisted response is no-store + no-referrer (PUB-1: token not cached/leaked)",
      /no-store/.test(bUnl.headers.get("cache-control") || "") && (bUnl.headers.get("referrer-policy") || "") === "no-referrer"
      && bUnl.body.includes('name="referrer" content="no-referrer"'), `cc=${bUnl.headers.get("cache-control")}`);
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

    // ── Revocation interlock (the CRITICAL that blocked this PR) ────────────
    // A leaked unlisted link MUST stop serving the moment the owner takes the
    // doc back. Before publish_nonce, the link below kept serving forever.
    await db.documents.unpublish(USER, "notes/b.md");
    const bAfterUnpub = await get(`/s/b-unl?t=${encodeURIComponent(bTok)}`);
    rec("S10. REVOCATION: old unlisted token → 404 after unpublish (nonce rotated)",
      bAfterUnpub.status === 404 && !bAfterUnpub.body.includes("UNLISTED_B_BODY"), `status=${bAfterUnpub.status}`);

    // Re-sharing mints a FRESH nonce: a new token works, the OLD one stays dead.
    const bRow2 = await db.documents.setPublicSlug(USER, "notes/b.md", "b-unl");
    rec("S11. re-share mints a fresh nonce (≠ the revoked one)",
      typeof bRow2.publish_nonce === "string" && bRow2.publish_nonce !== bRow.publish_nonce);
    const bTok2 = mintLink(identity, { slug: "b-unl", nonce: bRow2.publish_nonce });
    const bNew = await get(`/s/b-unl?t=${encodeURIComponent(bTok2)}`);
    const bOldStillDead = await get(`/s/b-unl?t=${encodeURIComponent(bTok)}`);
    rec("S12. new token serves; OLD (pre-revocation) token still → 404",
      bNew.status === 200 && bNew.body.includes("UNLISTED_B_BODY") && bOldStillDead.status === 404,
      `new=${bNew.status} old=${bOldStillDead.status}`);

    // revokeShareLinks kills links without changing published state.
    await db.documents.revokeShareLinks(USER, "notes/b.md");
    const bAfterRevoke = await get(`/s/b-unl?t=${encodeURIComponent(bTok2)}`);
    rec("S13. revokeShareLinks → all outstanding tokens → 404",
      bAfterRevoke.status === 404 && !bAfterRevoke.body.includes("UNLISTED_B_BODY"), `status=${bAfterRevoke.status}`);

    // The PUBLIC /p/ route must also stop serving after unpublish (published=0).
    await db.documents.unpublish(USER, "notes/a.md");
    const aAfterUnpub = await get("/p/a-pub");
    rec("S13b. /p/:slug → 404 after unpublish (public route revoked too)",
      aAfterUnpub.status === 404 && !aAfterUnpub.body.includes("PUBLIC_A_BODY"), `status=${aAfterUnpub.status}`);

    // ?t supplied multiple times (array) must not bypass the string-typed check.
    const bArr = await get(`/s/b-unl?t=x&t=y`);
    rec("S14. duplicate/array ?t param → 404 (no type-confusion bypass)", bArr.status === 404);

    // Final leakage sweep over the revocation-phase responses too.
    const all2 = [bAfterUnpub, bNew, bOldStillDead, bAfterRevoke, bArr].map((r) => r.body).join("\n");
    rec("S15. LEAKAGE GUARD (revocation phase): no UNLISTED body leaks once revoked",
      (all2.match(/UNLISTED_B_BODY/g) || []).length === 1); // only bNew (the legitimately re-shared) carries it
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  // ── Schema interlock (HIGH): refuse to serve if migration 0003 is absent ──
  // A DB without publish_nonce can't enforce revocation → fail closed at boot.
  const DB2 = "data/verify-publish-nomig.db", KCV2 = "data/verify-publish-nomig-kcv.json";
  for (const f of [DB2, KCV2, `${DB2}-shm`, `${DB2}-wal`]) { try { rmSync(f); } catch {} }
  const raw = new Database(DB2); applyMigrations(raw); raw.exec("ALTER TABLE documents DROP COLUMN publish_nonce"); raw.close();
  let refused = false;
  try {
    const bad = await startPublicServer({ dbPath: DB2, kcvPath: KCV2, userHex: hex(), systemHex: hex(), port: 0, host: "127.0.0.1" });
    bad.server.close(); try { bad.close?.(); } catch {}
  } catch (e) { refused = /publish_nonce/.test(String(e?.message)); }
  rec("S16. SCHEMA INTERLOCK: public server refuses to boot without publish_nonce (fail-closed)", refused);

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? "GO — identity + signed links + fail-closed public server (private content never served)" : "NO-GO — see FAIL rows"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("verify-publish threw:", e); process.exit(1); });
