// THROWAWAY SPIKE — Step 0 / R1. Not shipped. Validates whether better-auth
// satisfies the full MCP remote OAuth flow (discovery + DCR + PKCE-S256 + Bearer/mcp).
import express from "express";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import {
  mcp,
  withMcpAuth,
  oAuthDiscoveryMetadata,
  oAuthProtectedResourceMetadata,
} from "better-auth/plugins";
import { toNodeHandler } from "better-auth/node";
import { getMigrations } from "better-auth/db/migration";

const PORT = Number(process.env.PORT || 8788);
const BASE = `http://localhost:${PORT}`;

export const auth = betterAuth({
  baseURL: BASE,
  secret: "spike-secret-not-for-prod-0123456789abcdef",
  database: new Database("./spike-auth.db"),
  emailAndPassword: { enabled: true },
  plugins: [
    mcp({
      loginPage: "/login",
      resource: `${BASE}/mcp`,
      oidcConfig: {
        allowDynamicClientRegistration: true, // DCR (RFC 7591)
        requirePKCE: true, // refuse code flow without PKCE
        loginPage: "/login",
        storeClientSecret: "plain",
        // A pre-trusted client lets the probe complete authorize->token
        // headlessly (skipConsent) — the DCR path is tested separately.
        trustedClients: [
          {
            clientId: "spike-trusted",
            clientSecret: "spike-trusted-secret",
            name: "Spike Trusted Client",
            type: "web",
            redirectURLs: [`${BASE}/callback`],
            disabled: false,
            skipConsent: true,
            metadata: {},
          },
        ],
      },
    }),
  ],
});

// ---- in-process migration (creates user/session/account + oidc tables) ----
const migrations = await getMigrations(auth.options);
await migrations.runMigrations();
console.log("[spike] migrations applied");

const app = express();

// Root-level well-knowns that an unmodified MCP client probes first.
app.get("/.well-known/oauth-authorization-server", toNodeHandler(oAuthDiscoveryMetadata(auth)));
app.get("/.well-known/oauth-protected-resource", toNodeHandler(oAuthProtectedResourceMetadata(auth)));

// All better-auth + OIDC endpoints (/api/auth/*, incl. /oauth2/*).
app.all("/api/auth/*splat", toNodeHandler(auth));

// The protected MCP resource. withMcpAuth enforces Bearer + emits a
// 401 with WWW-Authenticate -> protected-resource metadata when missing.
const mcpHandler = withMcpAuth(auth, (req, session) => {
  return Response.json({
    ok: true,
    sub: session?.userId ?? session?.user?.id ?? null,
    scopes: session?.scopes ?? null,
  });
});
app.all("/mcp", toNodeHandler(mcpHandler));

app.listen(PORT, () => {
  console.log(`[spike] listening ${BASE}`);
  console.log(`[spike] AS metadata:  ${BASE}/.well-known/oauth-authorization-server`);
  console.log(`[spike] PR metadata:  ${BASE}/.well-known/oauth-protected-resource`);
});
