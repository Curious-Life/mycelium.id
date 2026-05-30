// THROWAWAY SPIKE probe — drives the full MCP OAuth flow against server.mjs and
// prints a GO/NO-GO ledger for the four Step-0 NO-GO conditions.
import crypto from "node:crypto";

const BASE = `http://localhost:${process.env.PORT || 8788}`;
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ledger = [];
const rec = (cond, pass, detail) => { ledger.push({ cond, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${cond}\n      ${detail}`); };

// tiny cookie jar
let cookies = {};
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
const stashCookies = (res) => {
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
};

async function main() {
  // 1 — DISCOVERY (RFC 8414)
  const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const need = ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "code_challenge_methods_supported"];
  const missing = need.filter((k) => !asMeta[k]);
  const s256 = (asMeta.code_challenge_methods_supported || []).includes("S256");
  rec("1. discovery doc shape", missing.length === 0 && s256,
    missing.length ? `missing: ${missing}` : `all endpoints present; code_challenge_methods=${JSON.stringify(asMeta.code_challenge_methods_supported)}`);

  // 2 — DCR (RFC 7591): register a brand-new public client, no auth
  const dcrRes = await fetch(asMeta.registration_endpoint, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "spike-dcr-client",
      redirect_uris: [`${BASE}/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const dcr = await dcrRes.json().catch(() => ({}));
  rec("2. DCR auto-accept", dcrRes.status < 300 && !!dcr.client_id,
    `status=${dcrRes.status} client_id=${dcr.client_id ?? "(none)"} auth_method=${dcr.token_endpoint_auth_method ?? "?"}`);
  const clientId = dcr.client_id;          // use the freshly DCR-registered public client
  const redirectUri = `${BASE}/callback`;  // for the full flow (Claude's real path)

  // --- authenticate a resource owner (single-user) ---
  // better-auth enforces an Origin header (CSRF). Browsers/MCP clients send it.
  const jsonOrigin = { "content-type": "application/json", origin: BASE };
  const email = `martin+${Date.now()}@spike.local`, password = "spike-Password-123";
  await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers: jsonOrigin, body: JSON.stringify({ email, password, name: "Martin" }) }).then(stashCookies);
  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers: jsonOrigin, body: JSON.stringify({ email, password }) });
  stashCookies(signIn);

  // 3 — AUTHORIZE + PKCE-S256. Codes are single-use, so run a FRESH cycle per
  // exchange: one for the negative (tampered verifier), one for the positive.
  const authorizeForChallenge = async (challenge) => {
    const authUrl = new URL(asMeta.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri,
      scope: "openid profile", state: b64url(crypto.randomBytes(8)),
      code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    const r = await fetch(authUrl, { headers: { cookie: cookieHeader() }, redirect: "manual" });
    const loc = r.headers.get("location") || "";
    let code = null; try { code = new URL(loc, BASE).searchParams.get("code"); } catch {}
    return { status: r.status, loc, code };
  };
  const exchange = async (code, verifier) => {
    const r = await fetch(asMeta.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: code || "", redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const mkPkce = () => { const v = b64url(crypto.randomBytes(32)); return { v, c: b64url(crypto.createHash("sha256").update(v).digest()) }; };

  // 3a: a valid PKCE authorize must issue a code
  const pkceGood = mkPkce();
  const authGood = await authorizeForChallenge(pkceGood.c);
  rec("3a. authorize issues a code (PKCE accepted, no interactive consent needed)", !!authGood.code,
    `status=${authGood.status} redirect=${authGood.loc.slice(0, 70)} code=${authGood.code ? authGood.code.slice(0, 10) + "…" : "(none)"}`);

  // 3b: tampered verifier (fresh code) MUST be rejected; correct verifier (fresh code) MUST succeed
  const pkceBad = mkPkce();
  const authForBad = await authorizeForChallenge(pkceBad.c);
  const bad = await exchange(authForBad.code, b64url(crypto.randomBytes(32))); // wrong verifier
  const good = authGood.code ? await exchange(authGood.code, pkceGood.v) : { status: 0, body: {} };
  const accessToken = good.body.access_token;
  rec("3b. PKCE S256 verified (wrong verifier rejected, correct accepted)",
    bad.status >= 400 && !!accessToken,
    `tampered->${bad.status}(${bad.body.error ?? "?"})  correct->${good.status} token=${accessToken ? accessToken.slice(0, 10) + "…" : "(none)"}`);

  // 4 — BEARER ON /mcp: negative (401 + WWW-Authenticate) and positive (200)
  const noTok = await fetch(`${BASE}/mcp`, { method: "POST" });
  const wwwAuth = noTok.headers.get("www-authenticate") || "";
  const withTok = accessToken ? await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${accessToken}` } }) : { status: 0 };
  rec("4. Bearer enforced on /mcp (401+challenge without; 200 with)",
    noTok.status === 401 && wwwAuth.toLowerCase().includes("resource_metadata") && withTok.status === 200,
    `no-token->${noTok.status} www-authenticate=${wwwAuth ? "present" : "MISSING"}  with-token->${withTok.status}`);

  // verdict
  const allPass = ledger.every((l) => l.pass);
  console.log("\n" + "=".repeat(64));
  console.log(`VERDICT: ${allPass ? "GO — better-auth satisfies the MCP OAuth flow" : "NO-GO — see FAIL rows above"}`);
  console.log("=".repeat(64));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("probe crashed:", e); process.exit(2); });
