/**
 * Portal profile router (Phase 10 PR 7D, Wave 1.1).
 *
 * Owns the user-profile surface — private profile read/update, handle
 * availability check, fingerprint recompute, public profile lookup,
 * and the two CDN-backed image upload endpoints (avatar + ex libris).
 *
 * 7 handlers:
 *
 *   Private profile (4):
 *     GET   /portal/profile                        — private profile + handle sync
 *     PUT   /portal/profile                        — update handle/display_name/signature
 *     GET   /portal/profile/handle/check           — format + availability check
 *     POST  /portal/profile/stats/recompute        — recompute fingerprint
 *
 *   Public profile (1):
 *     GET   /portal/profile/public/:handle         — public-safe view (no auth)
 *
 *   Image uploads (2):
 *     POST  /portal/avatar                         — resize 256×256 JPEG → R2
 *     POST  /portal/exlibris                       — resize 300×300 PNG → R2
 *
 * Reserved handles are enforced locally (a small hard-coded list).
 * Handle availability is checked against the owner-scope provisioning_jobs
 * table (cross-tenant uniqueness).
 *
 * Avatar + exlibris gate on `requireWorkerSecret` (localhost / Caddy /
 * worker-secret header), resize via sharp if available, upload to the
 * public R2 bucket through the Worker, and persist the CDN URL in both
 * `users` and `user_profiles`.
 */

import { Router } from 'express';
import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';

/**
 * @typedef {object} CreatePortalProfileRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {(req: any, res: any) => boolean}    requireWorkerSecret
 * @property {() => object|null}                  tryGetDb
 * @property {(err: Error, fallback?: string) => string} safeError
 * @property {object} config  — { LOG_PREFIX, MYA_WORKER_URL }
 * @property {object} [log]
 */

const RESERVED_HANDLES = Object.freeze([
  'admin', 'support', 'api', 'system', 'mycelium', 'vault',
  'login', 'signup', 'profile', 'settings', 'help', 'about',
  'discover', 'connections',
]);

const HANDLE_FORMAT_RE = /^[a-z0-9][a-z0-9_]{2,29}$/;

export function createPortalProfileRouter(deps) {
  if (!deps) throw new TypeError('createPortalProfileRouter: deps required');
  const {
    authenticatePortalRequest,
    requireWorkerSecret,
    tryGetDb,
    safeError,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalProfileRouter: authenticatePortalRequest required');
  }
  if (typeof requireWorkerSecret !== 'function') {
    throw new TypeError('createPortalProfileRouter: requireWorkerSecret required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalProfileRouter: tryGetDb required');
  }
  if (typeof safeError !== 'function') {
    throw new TypeError('createPortalProfileRouter: safeError required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalProfileRouter: config.LOG_PREFIX required');
  }
  if (!config?.MYA_WORKER_URL) {
    throw new TypeError('createPortalProfileRouter: config.MYA_WORKER_URL required');
  }

  const { LOG_PREFIX, MYA_WORKER_URL } = config;
  const logger = log || console;
  const router = Router();

  // Lazy-load sharp — optional dependency. When missing, avatar/exlibris
  // upload the raw buffer (no resize / EXIF strip). Production installs
  // always have sharp; this keeps tests + minimal envs from hard-failing.
  let _sharp = null;
  const getSharp = async () => {
    if (!_sharp) {
      try { _sharp = (await import('sharp')).default; }
      catch {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[${LOG_PREFIX}] sharp not installed — avatar processing disabled`
        );
      }
    }
    return _sharp;
  };

  // ── Private profile ───────────────────────────────────────────────

  router.get('/portal/profile', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      let profile = await db.profiles.get(user.id).catch(() => null);

      // Sync handle from provisioning if missing
      if (profile && !profile.handle) {
        try {
          const provRows = await db.rawQueryOwner(
            'SELECT handle FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
            [user.id, 'ready']
          );
          const provHandle = provRows?.[0]?.handle;
          if (provHandle) {
            await db.profiles.upsert(user.id, { handle: provHandle });
            profile.handle = provHandle;
          }
        } catch {}
      }

      if (!profile) {
        try {
          await db.profiles.computeFingerprint(user.id);
          profile = await db.profiles.get(user.id);
        } catch {
          let handle = null;
          try {
            const userRow = await db.rawQuery('SELECT handle, display_name FROM users WHERE id = ?', [user.id]);
            if (userRow?.[0]) { handle = userRow[0].handle; }
          } catch {}
          profile = {
            user_id: user.id,
            handle,
            display_name: user.displayName || null,
            signature: null,
            territory_count: 0, realm_count: 0, message_count: 0,
            depth_score: 0, breadth_score: 0, coherence_score: 0, exploration_score: 0,
            member_since: null, public_realms_json: null,
          };
        }
      }
      res.json({ profile });
    } catch (err) {
      (logger.error ? logger.error.bind(logger) : console.error)('[Profile] GET error:', err.message);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  router.put('/portal/profile', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const { handle, display_name, signature } = req.body || {};
      const updates = {};
      if (handle !== undefined) {
        await db.profiles.setHandle(user.id, handle);
      }
      if (display_name !== undefined) updates.display_name = display_name;
      if (signature !== undefined) updates.signature = signature;
      if (Object.keys(updates).length > 0) {
        await db.profiles.upsert(user.id, updates);
      }
      const profile = await db.profiles.get(user.id);
      res.json({ profile });
    } catch (err) {
      (logger.error ? logger.error.bind(logger) : console.error)('[Profile] PUT error:', err.message);
      res.status(400).json({ error: safeError(err, 'Failed to update profile') });
    }
  });

  router.get('/portal/profile/handle/check', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const handle = (req.query.handle || '').toLowerCase().trim();
      if (!handle || !HANDLE_FORMAT_RE.test(handle)) {
        return res.json({ available: false, reason: 'Invalid format' });
      }
      if (RESERVED_HANDLES.includes(handle)) {
        return res.json({ available: false, reason: 'Reserved' });
      }
      const db = tryGetDb();
      if (db) {
        try {
          const rows = await db.rawQueryOwner(
            'SELECT user_id FROM provisioning_jobs WHERE handle = ? AND user_id != ? AND status = ? LIMIT 1',
            [handle, user.id, 'ready']
          );
          if (rows?.length > 0) return res.json({ available: false, reason: 'Taken' });
        } catch {}
      }
      res.json({ available: true });
    } catch {
      res.json({ available: true }); // Fail open — validation happens on save
    }
  });

  router.post('/portal/profile/stats/recompute', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const stats = await db.profiles.computeFingerprint(user.id);
      res.json({ stats, message: 'Recomputed' });
    } catch (err) {
      (logger.error ? logger.error.bind(logger) : console.error)('[Profile] Recompute error:', err.message);
      res.status(500).json({ error: 'Failed to recompute' });
    }
  });

  // ── Public profile ────────────────────────────────────────────────

  router.get('/portal/profile/public/:handle', async (req, res) => {
    try {
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const profile = await db.profiles.getByHandle(req.params.handle);
      if (!profile) return res.status(404).json({ error: 'Not found' });
      const publicRealms = profile.public_realms_json ? JSON.parse(profile.public_realms_json) : [];
      const publicTerritories = await db.profiles.getPublicTerritories(profile.user_id);
      res.json({
        handle: profile.handle,
        display_name: profile.display_name,
        signature: profile.signature,
        depth_score: profile.depth_score,
        breadth_score: profile.breadth_score,
        coherence_score: profile.coherence_score,
        exploration_score: profile.exploration_score,
        territory_count: profile.territory_count,
        realm_count: profile.realm_count,
        message_count: profile.message_count,
        member_since: profile.member_since,
        realms: publicRealms,
        territories: publicTerritories.filter(t => t.visibility === 'public').map(t => ({
          name: t.name, essence: t.essence, realm_id: t.realm_id, message_count: t.message_count,
        })),
      });
    } catch (err) {
      (logger.error ? logger.error.bind(logger) : console.error)('[Profile] Public profile error:', err.message);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  // ── Image uploads (CDN: cdn.mycelium.id) ──────────────────────────

  router.post('/portal/avatar', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { image, targetId } = req.body || {};
      if (!image) return res.status(400).json({ error: 'image (base64) required' });

      const uploadId = targetId || user.id;

      // Verify ownership if targeting a space
      if (targetId && targetId !== user.id) {
        const db = tryGetDb();
        const role = await db?.spaces?.getRole(targetId, user.id);
        if (role !== 'creator') return res.status(403).json({ error: 'Only the creator can set the space avatar' });
      }

      const rawBuffer = Buffer.from(image, 'base64');
      if (rawBuffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 5MB)' });

      let processed;
      const sharp = await getSharp();
      if (sharp) {
        try {
          processed = await sharp(rawBuffer)
            .resize(256, 256, { fit: 'cover', position: 'centre' })
            .rotate()
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
        } catch {
          return res.status(400).json({ error: 'Invalid image format' });
        }
      } else {
        processed = rawBuffer;
      }

      const key = `avatars/${uploadId}.jpg`;
      const uploadRes = await fetch(`${MYA_WORKER_URL}/api/public-asset`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getWorkerSecret() || process.env.AGENT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: processed.toString('base64'),
          key,
          contentType: 'image/jpeg',
          userId: uploadId,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => '');
        (logger.error ? logger.error.bind(logger) : console.error)(
          `[${LOG_PREFIX}] Avatar upload failed: ${uploadRes.status} ${errText.substring(0, 200)}`
        );
        return res.status(500).json({ error: 'Upload failed' });
      }

      const { url: cdnUrl } = await uploadRes.json();

      const db = tryGetDb();
      await db.rawQuery('UPDATE users SET avatar_url = ? WHERE id = ?', [cdnUrl, uploadId]);
      await db.rawQuery('UPDATE user_profiles SET avatar_url = ? WHERE user_id = ?', [cdnUrl, uploadId]).catch(() => {});

      res.json({ avatarUrl: cdnUrl });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(`[${LOG_PREFIX}] Avatar upload failed:`, e.message);
      res.status(500).json({ error: 'Avatar upload failed' });
    }
  });

  router.post('/portal/exlibris', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { image } = req.body || {};
      if (!image) return res.status(400).json({ error: 'image (base64) required' });

      const rawBuffer = Buffer.from(image, 'base64');
      if (rawBuffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 5MB)' });

      let processed;
      const sharp = await getSharp();
      if (sharp) {
        try {
          processed = await sharp(rawBuffer)
            .resize(300, 300, { fit: 'cover', position: 'centre' })
            .rotate()
            .png({ quality: 90 })
            .toBuffer();
        } catch {
          return res.status(400).json({ error: 'Invalid image format' });
        }
      } else {
        processed = rawBuffer;
      }

      const key = `exlibris/${user.id}.png`;
      const uploadRes = await fetch(`${MYA_WORKER_URL}/api/public-asset`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getWorkerSecret() || process.env.AGENT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: processed.toString('base64'),
          key,
          contentType: 'image/png',
          userId: user.id,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => '');
        (logger.error ? logger.error.bind(logger) : console.error)(
          `[${LOG_PREFIX}] Ex libris upload failed: ${uploadRes.status} ${errText.substring(0, 200)}`
        );
        return res.status(500).json({ error: 'Upload failed' });
      }

      const { url: cdnUrl } = await uploadRes.json();

      const db = tryGetDb();
      await db.rawQuery('UPDATE users SET exlibris_url = ? WHERE id = ?', [cdnUrl, user.id]);
      await db.rawQuery('UPDATE user_profiles SET exlibris_url = ? WHERE user_id = ?', [cdnUrl, user.id]).catch(() => {});

      res.json({ exlibrisUrl: cdnUrl });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(`[${LOG_PREFIX}] Ex libris upload failed:`, e.message);
      res.status(500).json({ error: 'Ex libris upload failed' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-profile-router mounted 7 handlers`
  );

  return router;
}
