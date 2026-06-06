import express from 'express';

/**
 * authShimRouter — local "always signed in" auth surface for V1.
 *
 * The canonical portal was built for the cloud product, where every page
 * validates a session via `/auth/session` (portal-app root +layout.svelte) and
 * falls back to a passkey/Telegram login at `/login`. V1 is fundamentally
 * different: it is single-user and the vault is ALREADY UNLOCKED the moment the
 * server boots — the master keys are read at startup from the key source
 * (env / macOS Keychain / 1Password, see src/crypto/key-source.js) and the
 * process refuses to start without them (boot-time KCV gate, src/crypto/keys.js).
 * The REST surface has no per-request auth and binds localhost-only by design.
 *
 * So there is nothing for a browser "login" to unlock — the Keychain/1Password
 * integration lives on the SERVER (key source), not in the browser. This shim
 * makes the portal's session check succeed ("you are signed in") so the app
 * opens straight to the workspace instead of bouncing to a /login page V1 has
 * no backend for. It deliberately does NOT implement passkey/OAuth ceremonies.
 *
 * Mounted at `/auth`. Security note: this grants no new access — the data
 * surface already had no auth and is localhost-only (Phase 4 adds real auth for
 * any networked deployment). This only stops the UI demanding a login.
 *
 * @param {object} deps
 * @param {string} deps.userId  the single V1 owner id
 * @param {string} [deps.handle]
 * @param {(req: import('express').Request) => boolean | Promise<boolean>} [deps.resolveAuthorized]
 *   Optional gate for `/session`: when provided, a request that is NOT authorized
 *   gets 401 (so a networked browser bounces to /login). Default (loopback-only
 *   V1) is "always authorized" — desktop behavior is unchanged.
 * @returns {import('express').Router}
 */
export function authShimRouter({ userId, handle = 'local', resolveAuthorized }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const user = { id: userId, handle, display_name: 'You', avatar_url: null };

  // NOTE: mounted under '/auth' (see server-rest.js), so routes are relative —
  // this keeps the express.json parser scoped to /auth/* (it must not touch the
  // raw-bytes /api/v1/upload route).

  // The root layout calls this on every page; returning a user keeps the app
  // out of the /login redirect. For a networked client (over the relay) we gate
  // on resolveAuthorized so an unauthenticated browser gets 401 → /login.
  router.get('/session', async (req, res) => {
    if (resolveAuthorized) {
      try {
        if (!(await resolveAuthorized(req))) return res.status(401).json({ error: 'unauthorized' });
      } catch { return res.status(401).json({ error: 'unauthorized' }); }
    }
    res.json({ user });
  });

  // The /login page (not normally reached) reads this to decide its flow.
  router.get('/setup-status', (_req, res) =>
    res.json({ setupRequired: false, hasPasskeys: false, handle }));

  // Logout is a no-op locally (there's no session to end); report success so
  // the UI doesn't error. The next page load re-establishes "signed in".
  router.post('/logout', (_req, res) => res.json({ ok: true }));

  return router;
}

export default authShimRouter;
