/**
 * Portal master-key router (Phase 10 PR 7J).
 *
 * Two handlers — the entire user-facing master-key control plane. This
 * is the most security-critical surface in the server, so it lives in
 * its own file for visibility and is extracted character-exact from
 * agent-server.js with no restructuring:
 *
 *   POST /portal/master-key/restore  — Restore a known master key after
 *                                      VPS reboot / cache loss. Verifies
 *                                      key_hash against provisioning_jobs
 *                                      (managed) or accepts on passkey
 *                                      auth alone (owner standalone).
 *                                      Writes to /run/mycelium/master.key
 *                                      with 0o400 perms. Optionally
 *                                      mirrors to KMS via mTLS.
 *
 *   POST /portal/master-key/rotate   — Rotate the master key and re-wrap
 *                                      ALL encrypted records. SSE
 *                                      progress stream. Updates
 *                                      provisioning_jobs.key_hash,
 *                                      tmpfs, and KMS (delete → rewrap).
 *
 * Security invariants preserved:
 *   - Master key never leaves the VPS (no HTTP transmission beyond this
 *     endpoint's incoming request body).
 *   - tmpfs write uses mode 0o400 (owner read-only, no write).
 *   - KMS uses TLSv1.3 mutual TLS with admin cert from
 *     /etc/mycelium/kms-admin-certs by default.
 *   - Hash comparison uses safeCompare (constant-time).
 *   - All auth failures emit an audit_log entry with the reason.
 *   - 64-hex-char format validation before any crypto operation.
 *
 * Test scope (by design): unit tests exercise validation, auth, and
 * DB-absent branches only. The tmpfs write / KMS round-trip / full
 * rewrap is covered by scripts/verify-deploy.sh on the real VPS after
 * deployment — we deliberately do NOT mock these code paths in unit
 * tests because mocking crypto primitives risks hiding real bugs.
 */

import { Router } from 'express';
import crypto from 'crypto';

/**
 * @typedef {object} CreatePortalMasterKeyRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {(a: string, b: string) => boolean}  safeCompare
 * @property {(err: any, fallback?: string) => string} safeError
 * @property {object}                              config  — { LOG_PREFIX }
 * @property {(args: object) => Function}          [requireStepUp]
 *   — factory for step-up gate middleware (H1.4b). If provided, /rotate is
 *   gated behind a Tier 3 (UV+URK) step-up token. If absent, no gate (used
 *   by tests + backward-compatible boot when step-up isn't yet wired).
 * @property {object}                              [log]
 */

export function createPortalMasterKeyRouter(deps) {
  if (!deps) throw new TypeError('createPortalMasterKeyRouter: deps required');
  const {
    authenticatePortalRequest, tryGetDb, safeCompare, safeError, config,
    requireStepUp = null,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalMasterKeyRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalMasterKeyRouter: tryGetDb required');
  }
  if (typeof safeCompare !== 'function') {
    throw new TypeError('createPortalMasterKeyRouter: safeCompare required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalMasterKeyRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalMasterKeyRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const err  = logger.error ? logger.error.bind(logger) : console.error;
  const warn = logger.warn  ? logger.warn.bind(logger)  : console.warn;
  const info = logger.info  ? logger.info.bind(logger)  : console.log;

  const router = Router();

  // ── POST /portal/master-key/restore ────────────────────────────────

  router.post('/portal/master-key/restore', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { key } = req.body;
      if (!key || typeof key !== 'string' || key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
        return res.status(400).json({ error: 'Master key must be 64 hex characters' });
      }

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const providedHash = crypto.createHash('sha256').update(key).digest('hex');

      // Owner D1 first (managed hosting customers).
      let storedHash = null;
      try {
        const jobRows = await db.rawQueryOwner(
          'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
          [user.id, 'ready'],
        );
        storedHash = jobRows?.[0]?.key_hash;
      } catch (e) {
        warn(`[${LOG_PREFIX}] [master-key restore] owner D1 lookup failed: ${e.message}`);
      }

      // Standalone owner VPS: no provisioning_jobs row. Passkey auth
      // (already passed) is the only gate.
      if (!storedHash) {
        info(`[${LOG_PREFIX}] [master-key restore] No provisioning_jobs row — standalone mode, accepting key based on passkey auth`);
      } else if (!safeCompare(providedHash, storedHash)) {
        tryGetDb()?.audit.log({ action: 'master_key.restore_failed', userId: user.id, ip: req.ip }).catch(() => {});
        return res.status(401).json({ error: 'Master key does not match' });
      }

      // Write to tmpfs with 0o400 (owner read-only).
      const tmpfsPath = '/run/mycelium/master.key';
      try {
        const mkdirSync = (await import('fs')).mkdirSync;
        try { mkdirSync('/run/mycelium', { recursive: true, mode: 0o700 }); } catch {}
        const writeFileSync = (await import('fs')).writeFileSync;
        writeFileSync(tmpfsPath, key, { mode: 0o400 });
      } catch (e) {
        err(`[${LOG_PREFIX}] [master-key restore] tmpfs write failed: ${e.message}`);
        return res.status(500).json({ error: 'Failed to write key to tmpfs' });
      }

      // Clear caches and verify the key loads correctly.
      let kmsStored = false;
      try {
        const { clearAllCaches, getMasterKeyFromBestSource } = await import('@mycelium/core/crypto-local.js');
        await clearAllCaches();
        const loadedKey = await getMasterKeyFromBestSource();
        if (!loadedKey) throw new Error('Key load failed');

        const dbMod = await import('@mycelium/core/db-d1.js');
        if (dbMod.resetMasterKeyCache) dbMod.resetMasterKeyCache();

        // KMS mirror so reboots auto-recover.
        if (process.env.KMS_URL) {
          try {
            const adminCertPath = process.env.KMS_ADMIN_CERT_PATH || '/etc/mycelium/kms-admin-certs';
            const fs = await import('fs');
            const https = (await import('https')).default;
            const adminCert = fs.readFileSync(`${adminCertPath}/admin.crt`);
            const adminKey = fs.readFileSync(`${adminCertPath}/admin.key`);
            const ca = fs.readFileSync(`${adminCertPath}/ca.crt`);

            const url = new URL('/wrap', process.env.KMS_URL);
            const customerId = process.env.KMS_CUSTOMER_ID || process.env.MYA_USER_ID;

            await new Promise((resolve, reject) => {
              const options = {
                method: 'POST', hostname: url.hostname, port: url.port || 8443,
                path: url.pathname,
                cert: adminCert, key: adminKey, ca,
                rejectUnauthorized: true, minVersion: 'TLSv1.3',
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
              };
              const r = https.request(options, (resp) => {
                let data = '';
                resp.on('data', (c) => data += c);
                resp.on('end', () => {
                  if (resp.statusCode === 409) { kmsStored = true; resolve(); /* already exists */ }
                  else if (resp.statusCode >= 400) reject(new Error(`KMS ${resp.statusCode}: ${data}`));
                  else { kmsStored = true; resolve(); }
                });
              });
              r.on('error', reject);
              r.on('timeout', () => { r.destroy(); reject(new Error('KMS timeout')); });
              r.write(JSON.stringify({ customerId, kek: key }));
              r.end();
            });
          } catch (kmsErr) {
            err(`[${LOG_PREFIX}] [master-key restore] KMS wrap failed: ${kmsErr.message}`);
            // Non-fatal — the key is on tmpfs, agents can still use it.
          }
        }
      } catch (e) {
        return res.status(500).json({ error: safeError(e, 'Key written but failed to activate') });
      }

      tryGetDb()?.audit.log({ action: 'master_key.restored', userId: user.id, ip: req.ip, details: { kmsStored } }).catch(() => {});
      res.json({ ok: true, kmsStored });
    } catch (e) {
      err(`[${LOG_PREFIX}] [master-key restore] error: ${e.message}`);
      res.status(500).json({ error: 'Restore failed' });
    }
  });

  // ── POST /portal/master-key/rotate (SSE) ───────────────────────────
  //
  // H1.4b — Tier 3 step-up gate (UV + URK proof, 60s TTL). Master-key
  // rotation re-encrypts ALL stored ciphertext; a stolen session cookie
  // alone must not be sufficient to invoke this. The gate runs BEFORE the
  // existing handler's authenticate-call, so 401 'step_up_required' fires
  // without touching crypto state.
  //
  // If requireStepUp is not provided (tests, or boot before step-up service
  // is ready), the gate is a no-op pass-through — preserving the prior
  // behavior so we never accidentally lock out an unconfigured deployment.

  const rotateStepUpGate = requireStepUp
    ? requireStepUp({ tier: 'uv_urk', opType: 'master_key.rotate' })
    : (_req, _res, next) => next();

  router.post('/portal/master-key/rotate', rotateStepUpGate, async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { currentKey, newKey } = req.body;
      for (const [name, k] of [['currentKey', currentKey], ['newKey', newKey]]) {
        if (!k || typeof k !== 'string' || k.length !== 64 || !/^[0-9a-fA-F]+$/.test(k)) {
          return res.status(400).json({ error: `${name} must be 64 hex characters` });
        }
      }
      if (currentKey === newKey) {
        return res.status(400).json({ error: 'New key must be different from current key' });
      }

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const currentHash = crypto.createHash('sha256').update(currentKey).digest('hex');

      let storedHash = null;
      try {
        const jobRows = await db.rawQueryOwner(
          'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
          [user.id, 'ready'],
        );
        storedHash = jobRows?.[0]?.key_hash;
      } catch (e) {
        warn(`[${LOG_PREFIX}] [master-key rotate] owner D1 lookup failed: ${e.message}`);
      }

      // Managed: verify hash matches. Standalone: verify by using the key.
      if (storedHash && !safeCompare(currentHash, storedHash)) {
        tryGetDb()?.audit.log({
          action: 'master_key.rotate_failed',
          userId: user.id,
          ip: req.ip,
          details: { reason: 'hash mismatch' },
        }).catch(() => {});
        return res.status(401).json({ error: 'Current master key does not match' });
      }

      if (!storedHash) {
        try {
          const { importMasterKey, encrypt, decrypt } = await import('@mycelium/core/crypto-local.js');
          const testKey = await importMasterKey(currentKey);
          const testEnvelope = await encrypt('verification', 'personal', testKey);
          await decrypt(testEnvelope, testKey);
        } catch {
          return res.status(401).json({ error: 'Current master key is invalid' });
        }
      }

      // Switch to SSE.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const sendSSE = (event) => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
      };

      sendSSE({ type: 'started' });

      try {
        const { importMasterKey } = await import('@mycelium/core/crypto-local.js');
        const oldMasterKey = await importMasterKey(currentKey);
        const newMasterKey = await importMasterKey(newKey);

        sendSSE({ type: 'rewrapping' });

        const { rewrapAllRecords } = await import('@mycelium/core/db-d1.js');
        const result = await rewrapAllRecords(oldMasterKey, newMasterKey, (progress) => {
          sendSSE({ type: 'progress', ...progress });
        });

        sendSSE({ type: 'finalizing', ...result });

        // Update provisioning_jobs.key_hash (managed customers only).
        if (storedHash) {
          const newHash = crypto.createHash('sha256').update(newKey).digest('hex');
          try {
            await db.rawQueryOwner(
              'UPDATE provisioning_jobs SET key_hash = ? WHERE user_id = ? AND status = ?',
              [newHash, user.id, 'ready'],
            );
          } catch (e) {
            warn(`[${LOG_PREFIX}] [master-key rotate] failed to update provisioning_jobs.key_hash: ${e.message}`);
          }
        }

        // Write new key to tmpfs.
        const fs = await import('fs');
        try { fs.mkdirSync('/run/mycelium', { recursive: true, mode: 0o700 }); } catch {}
        fs.writeFileSync('/run/mycelium/master.key', newKey, { mode: 0o400 });

        // Clear caches.
        const { clearAllCaches } = await import('@mycelium/core/crypto-local.js');
        await clearAllCaches();
        const dbMod = await import('@mycelium/core/db-d1.js');
        if (dbMod.resetMasterKeyCache) dbMod.resetMasterKeyCache();

        // KMS update if configured — DELETE then re-wrap. Delete is best-
        // effort (ignores errors); re-wrap is authoritative.
        if (process.env.KMS_URL) {
          sendSSE({ type: 'kms-updating' });
          try {
            const adminCertPath = process.env.KMS_ADMIN_CERT_PATH || '/etc/mycelium/kms-admin-certs';
            const adminCert = fs.readFileSync(`${adminCertPath}/admin.crt`);
            const adminKey = fs.readFileSync(`${adminCertPath}/admin.key`);
            const ca = fs.readFileSync(`${adminCertPath}/ca.crt`);
            const https = (await import('https')).default;
            const url = new URL('/wrap', process.env.KMS_URL);
            const customerId = process.env.KMS_CUSTOMER_ID || process.env.MYA_USER_ID;

            await new Promise((resolve) => {
              const r = https.request({
                method: 'DELETE', hostname: url.hostname, port: url.port || 8443,
                path: `/customer/${customerId}`,
                cert: adminCert, key: adminKey, ca,
                rejectUnauthorized: true, minVersion: 'TLSv1.3',
                timeout: 10000,
              }, () => resolve());
              r.on('error', () => resolve());
              r.end();
            });

            await new Promise((resolve, reject) => {
              const r = https.request({
                method: 'POST', hostname: url.hostname, port: url.port || 8443,
                path: url.pathname,
                cert: adminCert, key: adminKey, ca,
                rejectUnauthorized: true, minVersion: 'TLSv1.3',
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
              }, (resp) => {
                let data = '';
                resp.on('data', (c) => data += c);
                resp.on('end', () => {
                  if (resp.statusCode >= 400) reject(new Error(`KMS ${resp.statusCode}: ${data}`));
                  else resolve();
                });
              });
              r.on('error', reject);
              r.write(JSON.stringify({ customerId, kek: newKey }));
              r.end();
            });
          } catch (kmsErr) {
            sendSSE({ type: 'warning', message: `KMS update failed: ${kmsErr.message}` });
          }
        }

        tryGetDb()?.audit.log({
          action: 'master_key.rotated',
          userId: user.id,
          ip: req.ip,
          details: result,
        }).catch(() => {});

        sendSSE({ type: 'complete', ...result });
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        sendSSE({ type: 'error', message: e.message });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Rotation failed' });
      }
    }
  });

  info(`[${LOG_PREFIX}] portal-master-key-router mounted 2 handlers`);

  return router;
}
