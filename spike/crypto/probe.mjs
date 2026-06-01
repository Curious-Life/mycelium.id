// THROWAWAY crypto spike — verifies the UNMODIFIED reference crypto-local.js
// (D3 envelope, D4 hex-key/KCV, D6 two-key separation) runs and behaves
// fail-closed under the V1 runtime. Run: node probe.mjs
import crypto from "node:crypto";
import {
  importMasterKey, encrypt, encryptWithSystemKey, decrypt, rewrapEnvelope, ScopeViolationError,
} from "./crypto-local.js";

const ledger = [];
const rec = (name, pass, detail) => { ledger.push(pass); console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`); };
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const hex = () => crypto.randomBytes(32).toString("hex"); // 64-char hex = 32 bytes (D4)

// distinct keys
const hUserOld = hex(), hUserNew = hex(), hWrong = hex(), hSystem = hex();
const uOld = await importMasterKey(hUserOld);
const uNew = await importMasterKey(hUserNew);
const uWrong = await importMasterKey(hWrong);
const sKey = await importMasterKey(hSystem);

// ── A2: v1 user-scope round-trip ──
{
  const env = await encrypt("hello user", "personal", uOld);
  const decoded = JSON.parse(Buffer.from(env, "base64").toString());
  const out = await decrypt(env, uOld);
  rec("A2. v1 user round-trip + envelope shape {v,s,iv,ct,dk}",
    out === "hello user" && decoded.v === 1 && ["s", "iv", "ct", "dk"].every(k => k in decoded),
    `roundtrip=${out === "hello user"} v=${decoded.v} keys={${Object.keys(decoded).join(",")}}`);
}

// ── A2b: v2 per-user envelope (import-read path; V1 writes v1 but must READ v2) ──
{
  const env = await encrypt("per-user data", "personal", uOld, "user-123");
  const decoded = JSON.parse(Buffer.from(env, "base64").toString());
  const out = await decrypt(env, uOld);
  const wrongKey = await threw(() => decrypt(env, uWrong));
  rec("A2b. v2 per-user round-trip (envelope carries u; decrypt re-derives user key)",
    out === "per-user data" && decoded.v === 2 && decoded.u === "user-123" && wrongKey !== null,
    `roundtrip=${out === "per-user data"} v=${decoded.v} u=${decoded.u} wrong-key-> ${wrongKey ? "threw" : "BAD"}`);
}

// ── A3: system-key round-trip (v3, kf='system') ──
{
  const env = await encryptWithSystemKey("system secret", "personal", sKey);
  const decoded = JSON.parse(Buffer.from(env, "base64").toString());
  const out = await decrypt(env, null, null, { systemKey: sKey });
  rec("A3. system round-trip (v3 kf='system')",
    out === "system secret" && decoded.v === 3 && decoded.kf === "system",
    `roundtrip=${out === "system secret"} v=${decoded.v} kf=${decoded.kf}`);
}

// ── A4 (KCV foundation): wrong key fails closed; correct key decrypts ──
{
  const env = await encrypt("mycelium-kcv-v1", "personal", uOld);
  const good = await decrypt(env, uOld);
  const err = await threw(() => decrypt(env, uWrong));
  rec("A4. KCV mechanism — correct key decrypts, WRONG key throws (fail-closed)",
    good === "mycelium-kcv-v1" && err !== null,
    `correct='${good}'  wrong-key-> ${err ? "threw: " + err.name : "DID NOT THROW (BAD)"}`);
}

// ── A4b: malformed/truncated hex rejected at import ──
{
  const errShort = await threw(() => importMasterKey(hUserOld.slice(0, 63))); // 63 chars
  const errEmpty = await threw(() => importMasterKey(""));
  rec("A4b. importMasterKey rejects truncated/empty hex",
    errShort !== null && errEmpty !== null,
    `63-char-> ${errShort ? "rejected" : "ACCEPTED (BAD)"}  empty-> ${errEmpty ? "rejected" : "ACCEPTED (BAD)"}`);
}

// ── A5: rewrapEnvelope — the import re-key path ──
{
  const env = await encrypt("rotate me", "personal", uOld);
  const rewrapped = await rewrapEnvelope(env, uOld, uNew);
  const outNew = await decrypt(rewrapped, uNew);
  const errOldKeyOnNewEnv = await threw(() => decrypt(rewrapped, uOld));
  const errNewKeyOnOldEnv = await threw(() => decrypt(env, uNew));
  rec("A5. rewrapEnvelope re-keys (old->new): new key decrypts, old key rejected",
    outNew === "rotate me" && errOldKeyOnNewEnv !== null && errNewKeyOnOldEnv !== null,
    `new-key='${outNew}'  old-key-on-rewrapped-> ${errOldKeyOnNewEnv ? "threw" : "BAD"}  new-key-on-old-env-> ${errNewKeyOnOldEnv ? "threw" : "BAD"}`);
}

// ── A6 (D6): two-key separation — user ⊥ system ──
{
  const sysEnv = await encryptWithSystemKey("infra", "personal", sKey);
  const userEnv = await encrypt("user data", "personal", uOld);
  const errNoSystemKey = await threw(() => decrypt(sysEnv, uOld));                       // system env, no systemKey provided
  const errWrongSystemKey = await threw(() => decrypt(sysEnv, null, null, { systemKey: uOld })); // user key used as system key
  const errUserAsSystem = await threw(() => decrypt(userEnv, sKey));                     // user env, decrypted with system key
  rec("A6. D6 two-key separation (USER_MASTER ⊥ SYSTEM_KEY)",
    errNoSystemKey !== null && errWrongSystemKey !== null && errUserAsSystem !== null,
    `sys-env w/o systemKey-> ${errNoSystemKey ? "threw" : "BAD"}  sys-env w/ user-key-> ${errWrongSystemKey ? "threw" : "BAD"}  user-env w/ system-key-> ${errUserAsSystem ? "threw" : "BAD"}`);
}

// ── A7: scope-decryption guardian ──
{
  const env = await encrypt("scoped", "personal", uOld);
  const denied = await threw(() => decrypt(env, uOld, ["org"]));        // scope not allowed
  const allowed = await decrypt(env, uOld, ["personal"]);              // scope allowed
  const admin = await decrypt(env, uOld, null);                        // admin (null)
  rec("A7. scope-decryption guardian (allowedScopes enforced, null=admin)",
    denied instanceof ScopeViolationError && allowed === "scoped" && admin === "scoped",
    `wrong-scope-> ${denied ? denied.name : "BAD"}  allowed='${allowed}'  admin='${admin}'`);
}

// ── A8: scope-encryption guardian (write side, AGENT_SCOPES) ──
{
  process.env.AGENT_SCOPES = JSON.stringify(["personal"]);
  const denied = await threw(() => encrypt("x", "org", uOld));        // target scope not in AGENT_SCOPES
  const ok = await threw(() => encrypt("x", "personal", uOld));       // allowed
  delete process.env.AGENT_SCOPES;
  const adminAny = await threw(() => encrypt("x", "org", uOld));      // admin mode -> any scope
  rec("A8. scope-encryption guardian (AGENT_SCOPES gates write scope)",
    denied instanceof ScopeViolationError && ok === null && adminAny === null,
    `org w/ scopes=[personal]-> ${denied ? denied.name : "BAD"}  personal-> ${ok ? "threw(BAD)" : "ok"}  admin org-> ${adminAny ? "threw(BAD)" : "ok"}`);
}

const allPass = ledger.every(Boolean);
console.log("\n" + "=".repeat(64));
console.log(`VERDICT: ${allPass ? "GO — crypto-local.js (D3/D4/D6) runs unmodified + fails closed" : "NO-GO — see FAIL rows"}`);
console.log("=".repeat(64));
process.exit(allPass ? 0 : 1);
