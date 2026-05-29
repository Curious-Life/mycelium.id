/**
 * Portal export/import router (Phase 10 PR 7D, Wave 3.3).
 *
 * 9 handlers that own the vault-backup + account-deletion surface —
 * the most security-sensitive endpoints in the portal. Re-authentication,
 * rate limiting, and audit logging are enforced on every entry point.
 *
 *   POST /portal/export/auth            — issue passkey challenge OR
 *                                          (no passkeys / not managed)
 *                                          short-circuit and hand back
 *                                          a session-only export token
 *   POST /portal/export/verify          — verify passkey or master-key
 *                                          hash, hand back a one-time
 *                                          5-minute export token
 *   POST /portal/export                 — full vault: messages, docs,
 *                                          attachments (R2-downloaded),
 *                                          mindscape, contacts, health,
 *                                          activity, wealth, canvases,
 *                                          tasks, reflections, ai
 *                                          providers, agent filesystem.
 *                                          Managed mode uploads to R2 +
 *                                          emails a signed URL + PIN;
 *                                          self-hosted streams a ZIP.
 *   POST /portal/import/vault           — full restore from a v3
 *                                          mycelium-vault-export ZIP
 *                                          (2GB upload cap, multipart).
 *   POST /portal/import/messages        — bulk insert (≤100/batch)
 *                                          from browser-parsed data
 *   POST /portal/import/documents       — bulk upsert (≤100/batch)
 *   POST /portal/delete-account/auth    — same passkey/master-key
 *                                          challenge as export, but
 *                                          issues a deletion-token kind
 *   POST /portal/delete-account/verify  — verify reauth, hand back a
 *                                          one-time 5-minute deletion
 *                                          token
 *   POST /portal/delete-account         — irreversible GDPR-style
 *                                          wipe across D1 user tables,
 *                                          R2 attachments, Vectorize
 *                                          (search + cluster), passkeys,
 *                                          identities. Requires the
 *                                          literal phrase
 *                                          "DELETE ALL MY DATA".
 *
 * EVERY handler shares:
 *   - `exportTokens` one-time Map (5-min TTL, consumed on use)
 *   - burst limit (2/min) + daily limit (3/day)
 *   - `logEvent('security.*', ...)` audit on success + failure
 *
 * The `exportTokens` Map + its cleanup setInterval live inside the
 * factory closure — no external consumer, and this way each
 * createPortalExportImportRouter() call is test-isolated.
 *
 * Cross-surface helpers (auth, DB, rate limiters) are threaded via
 * deps. Static imports handle Busboy + JSZip (JSZip dynamic to defer
 * load cost to first use) and @mycelium/core helpers.
 */

import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import Busboy from 'busboy';

import { logEvent } from '@mycelium/core/events.js';
import { getAgentsRoot } from '@mycelium/core/paths.js';
import {
  saveDocument, validatePath, ALLOWED_SCOPES, SaveDocumentError,
} from '@mycelium/core/document-store.js';

import { getWorkerUrl, getWorkerSecret, hasWorkerSecret } from '@mycelium/core/env.js';
import {
  createDeletionRecord,
  recordLedgerEntry,
  markRecordStatus,
} from '@mycelium/core/account-deletion/ledger.js';
import { transition, STATUS } from '@mycelium/core/account-deletion/state.js';
import { getD1UserTables } from '@mycelium/core/account-deletion/catalog.js';
import { fetchDeletionReport } from '@mycelium/core/account-deletion/ledger.js';
const EXPORT_TOKEN_TTL = 300_000;          // 5 minutes
const EXPORT_DAILY_LIMIT = 3;
const EXPORT_BURST_PER_MIN = 2;
const EXPORT_IMPORT_TOKEN_CLEANUP_INTERVAL = 60_000;
const IMPORT_MESSAGE_BATCH_CAP = 100;
const IMPORT_DOCUMENT_BATCH_CAP = 100;
const VAULT_UPLOAD_LIMIT_BYTES = 2_000_000_000;  // 2GB
const KEY_HASH_HEX_RE = /^[0-9a-f]{64}$/i;

// Account deletion: irreversible. Tighter limits than export.
const DELETION_DAILY_LIMIT = 1;
const DELETION_BURST_PER_MIN = 1;
const DELETION_CONFIRMATION_PHRASE = 'DELETE ALL MY DATA';
// DELETION_ID_BATCH removed Wave 4b — Vectorize delete path no longer used.

/**
 * @typedef {object} CreatePortalExportImportRouterDeps
 * @property {(req: any) => Promise<object|null>} authenticatePortalRequest
 * @property {() => object|null}                  tryGetDb
 * @property {() => Promise<object>}              getAuthModule
 * @property {(req: any, res: any) => boolean}    checkAuthRateLimit
 * @property {(req: any, res: any, endpoint: string, maxPerMinute?: number) => boolean} checkRateLimit
 * @property {(userId: string, operation: string, maxPerDay?: number) => boolean} checkDailyLimit
 * @property {(event: string, req: any, details?: any) => Promise<any>} [sendSecurityEmail]
 * @property {object} config  — { LOG_PREFIX }
 * @property {object} [log]
 */

export function createPortalExportImportRouter(deps) {
  if (!deps) throw new TypeError('createPortalExportImportRouter: deps required');
  const {
    authenticatePortalRequest,
    tryGetDb,
    getAuthModule,
    checkAuthRateLimit,
    checkRateLimit,
    checkDailyLimit,
    sendSecurityEmail,
    config,
    log,
  } = deps;

  if (typeof authenticatePortalRequest !== 'function') {
    throw new TypeError('createPortalExportImportRouter: authenticatePortalRequest required');
  }
  if (typeof tryGetDb !== 'function') {
    throw new TypeError('createPortalExportImportRouter: tryGetDb required');
  }
  if (typeof getAuthModule !== 'function') {
    throw new TypeError('createPortalExportImportRouter: getAuthModule required');
  }
  if (typeof checkAuthRateLimit !== 'function') {
    throw new TypeError('createPortalExportImportRouter: checkAuthRateLimit required');
  }
  if (typeof checkRateLimit !== 'function') {
    throw new TypeError('createPortalExportImportRouter: checkRateLimit required');
  }
  if (typeof checkDailyLimit !== 'function') {
    throw new TypeError('createPortalExportImportRouter: checkDailyLimit required');
  }
  if (!config?.LOG_PREFIX) {
    throw new TypeError('createPortalExportImportRouter: config.LOG_PREFIX required');
  }

  const { LOG_PREFIX } = config;
  const logger = log || console;
  const router = Router();

  // One-time export tokens: Map<token, { userId, createdAt }>.
  // Scoped to this router instance — tests get a fresh Map per build.
  const exportTokens = new Map();

  // Separate map for account-deletion tokens. Parallel to exportTokens so the
  // two flows can't be mixed (an export token can't be used to delete, and
  // vice-versa). Same TTL + cleanup cadence.
  const deletionTokens = new Map();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of exportTokens) {
      if (now - v.createdAt > EXPORT_TOKEN_TTL) exportTokens.delete(k);
    }
    for (const [k, v] of deletionTokens) {
      if (now - v.createdAt > EXPORT_TOKEN_TTL) deletionTokens.delete(k);
    }
  }, EXPORT_IMPORT_TOKEN_CLEANUP_INTERVAL);
  // Let the event loop exit even if the interval is still pending
  // (matters for tests that spin up + tear down routers repeatedly).
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  // Fire-and-forget security email. Never throws up the chain.
  const notifySecurity = (event, req, details) => {
    if (typeof sendSecurityEmail === 'function') {
      sendSecurityEmail(event, req, details).catch(() => {});
    }
  };

  // ── Helpers for /portal/import/vault ──────────────────────────────

  async function restoreRaw(db, targetUserId, table, rows, userIdCol = 'user_id') {
    if (!rows || !rows.length) return 0;
    let count = 0;
    for (const row of rows) {
      try {
        if (targetUserId && row[userIdCol]) row[userIdCol] = targetUserId;
        const cols = Object.keys(row).filter(c => row[c] !== undefined);
        const vals = cols.map(c => row[c]);
        const placeholders = cols.map(() => '?').join(', ');
        await db.rawQuery(
          `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
          vals
        );
        count++;
      } catch { /* skip individual row failures (constraint violations, etc.) */ }
    }
    return count;
  }

  async function restoreClusteringPoints(db, targetUserId, points, embeddings) {
    if (!points?.length) return 0;
    let count = 0;
    for (const pt of points) {
      try {
        pt.user_id = targetUserId;
        const hex = embeddings?.[pt.id];
        const cols = Object.keys(pt).filter(c => pt[c] !== undefined);
        const vals = cols.map(c => pt[c]);
        let sql;
        if (hex) {
          const placeholders = cols.map(() => '?').join(', ') + `, x'${hex}'`;
          sql = `INSERT OR REPLACE INTO clustering_points (${cols.join(', ')}, nomic_embedding) VALUES (${placeholders})`;
        } else {
          const placeholders = cols.map(() => '?').join(', ');
          sql = `INSERT OR REPLACE INTO clustering_points (${cols.join(', ')}) VALUES (${placeholders})`;
        }
        await db.rawQuery(sql, vals);
        count++;
      } catch {}
    }
    return count;
  }

  async function restoreAttachments(db, targetUserId, attachments, zip, workerUrl, workerSecret) {
    if (!attachments?.length) return { inserted: 0, uploaded: 0, failed: 0 };
    let inserted = 0, uploaded = 0, failed = 0;

    for (const att of attachments) {
      try {
        const zipEntry = att.zipPath ? zip.file(att.zipPath) : null;
        if (zipEntry && workerUrl && workerSecret) {
          try {
            const buf = await zipEntry.async('nodebuffer');
            const ext = att.file_name ? path.extname(att.file_name) : '';
            const r2Key = `${targetUserId}/${att.file_type || 'file'}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

            const r2Res = await fetch(`${workerUrl}/api/store-attachment`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${workerSecret}`,
                'Content-Type': att.file_type === 'image' ? 'image/jpeg' : 'application/octet-stream',
                'X-Filename': att.file_name || 'file',
                'X-User-Id': targetUserId,
              },
              body: buf,
              signal: AbortSignal.timeout(30000),
            });

            if (r2Res.ok) {
              const result = await r2Res.json();
              att.r2_key = result.r2Key || r2Key;
              uploaded++;
            }
          } catch { failed++; }
        }

        const record = { ...att };
        record.user_id = targetUserId;
        delete record.zipPath;
        delete record.fetchError;
        delete record.downloadUrl;
        await db.attachments.insert(record);
        inserted++;
      } catch { failed++; }
    }
    return { inserted, uploaded, failed };
  }

  async function restoreAgentFiles(zip) {
    const agentsRoot = getAgentsRoot();
    let count = 0;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!name.startsWith('agents/') || entry.dir) continue;
      try {
        const targetPath = path.join(agentsRoot, name.slice('agents/'.length));
        // Safety: don't write outside agents root (protects against
        // malicious `../../../etc/passwd`-style paths inside the ZIP).
        if (!targetPath.startsWith(agentsRoot)) continue;
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, await entry.async('nodebuffer'));
        count++;
      } catch {}
    }
    return count;
  }

  async function addDirToZip(zipObj, dirPath, zipPrefix) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const zipPath = `${zipPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'repo', 'sessions', 'logs'].includes(entry.name)) continue;
          await addDirToZip(zipObj, fullPath, zipPath);
        } else {
          try {
            const content = await fs.readFile(fullPath);
            zipObj.file(zipPath, content);
          } catch {}
        }
      }
    } catch {}
  }

  // ── /portal/export/auth ───────────────────────────────────────────

  router.post('/portal/export/auth', async (req, res) => {
    if (!checkAuthRateLimit(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });
      const creds = await db.passkeys.listByUser(user.id);
      if (!creds || creds.length === 0) {
        // No passkeys — session-only auth fallback.
        const token = crypto.randomBytes(32).toString('hex');
        exportTokens.set(token, { userId: user.id, createdAt: Date.now() });
        return res.json({ exportToken: token, reauthRequired: false });
      }

      const userId = process.env.MYA_USER_ID;
      let hasMasterKeyOption = false;
      if (userId) {
        try {
          const rows = await db.rawQueryOwner(
            'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
            [userId, 'ready']
          );
          hasMasterKeyOption = !!rows?.[0]?.key_hash;
        } catch {}
      }

      const auth = await getAuthModule();
      const options = await auth.generateAuthOptions();
      res.json({ options, reauthRequired: true, hasMasterKeyOption });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Export] Auth options failed:', e.message
      );
      res.status(500).json({ error: 'Re-authentication unavailable' });
    }
  });

  // ── /portal/export/verify ─────────────────────────────────────────

  router.post('/portal/export/verify', async (req, res) => {
    if (!checkAuthRateLimit(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { credential, keyHash } = req.body || {};

      // Option A: master key hash verification (managed instances).
      // Swiss Vault: only the hash is sent, never the raw key.
      if (keyHash) {
        if (keyHash.length !== 64 || !KEY_HASH_HEX_RE.test(keyHash)) {
          return res.status(400).json({ error: 'Invalid key hash format' });
        }

        const userId = process.env.MYA_USER_ID;
        if (!userId) return res.status(503).json({ error: 'Not available' });

        let storedHash = null;
        const workerUrl = getWorkerUrl();
        const agentToken = process.env.AGENT_TOKEN || process.env.AGENT_TOKEN_MYA;

        if (workerUrl && agentToken) {
          try {
            const wRes = await fetch(`${workerUrl}/api/db/query`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
              body: JSON.stringify({
                sql: 'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
                params: [userId, 'ready'],
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (wRes.ok) {
              const data = await wRes.json();
              storedHash = data.results?.[0]?.key_hash;
            } else {
              (logger.error ? logger.error.bind(logger) : console.error)(
                `[Export] Key hash query failed: ${wRes.status} ${await wRes.text().catch(() => '')}`
              );
            }
          } catch (e) {
            (logger.error ? logger.error.bind(logger) : console.error)(
              '[Export] Key hash query error:', e.message
            );
          }
        }

        if (!storedHash) {
          return res.status(404).json({ error: 'No key hash on file' });
        }

        const a = Buffer.from(keyHash, 'hex');
        const b = Buffer.from(storedHash, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          logEvent('security.reauth_failed', { userId: user.id, ip: req.ip, method: 'key_hash' });
          return res.status(401).json({ error: 'Invalid key' });
        }

        logEvent('security.reauth_success', { userId: user.id, ip: req.ip, method: 'key_hash' });
        const token = crypto.randomBytes(32).toString('hex');
        exportTokens.set(token, { userId: user.id, createdAt: Date.now() });
        return res.json({ exportToken: token });
      }

      // Option B: passkey verification.
      if (!credential) return res.status(400).json({ error: 'Credential or key hash required' });

      const auth = await getAuthModule();
      const result = await auth.verifyAuth(credential);

      if (!result.verified) {
        logEvent('security.reauth_failed', { userId: user.id, ip: req.ip, method: 'passkey' });
        return res.status(401).json({ error: 'Re-authentication failed' });
      }

      logEvent('security.reauth_success', { userId: user.id, ip: req.ip, method: 'passkey' });

      const token = crypto.randomBytes(32).toString('hex');
      exportTokens.set(token, { userId: user.id, createdAt: Date.now() });
      res.json({ exportToken: token });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Export] Re-auth verify failed:', e.message
      );
      logEvent('security.reauth_failed', { userId: 'unknown', ip: req.ip, reason: e.message });
      res.status(400).json({ error: 'Re-authentication failed' });
    }
  });

  // ── /portal/export ────────────────────────────────────────────────

  router.post('/portal/export', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { exportToken } = req.body || {};
      if (exportToken) {
        const entry = exportTokens.get(exportToken);
        if (!entry) return res.status(401).json({ error: 'Invalid or expired export token' });
        if (Date.now() - entry.createdAt > EXPORT_TOKEN_TTL) {
          exportTokens.delete(exportToken);
          return res.status(401).json({ error: 'Export token expired' });
        }
        if (entry.userId !== user.id) return res.status(401).json({ error: 'Token/user mismatch' });
        exportTokens.delete(exportToken); // single-use
      } else {
        const db2 = tryGetDb();
        if (db2) {
          const creds = await db2.passkeys.listByUser(user.id);
          if (creds && creds.length > 0) {
            return res.status(401).json({ error: 'Re-authentication required. Call /portal/export/auth first.' });
          }
        }
      }

      if (!checkDailyLimit(user.id, 'export', EXPORT_DAILY_LIMIT)) {
        logEvent('security.export_failed', { userId: user.id, ip: req.ip, reason: 'daily_limit' });
        return res.status(429).json({ error: 'Export limit exceeded. Maximum 3 exports per day.' });
      }
      if (!checkRateLimit(req, res, 'export', EXPORT_BURST_PER_MIN)) {
        logEvent('security.export_failed', { userId: user.id, ip: req.ip, reason: 'burst_limit' });
        return;
      }

      logEvent('security.export_requested', { userId: user.id, ip: req.ip, ua: req.headers['user-agent'] });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const userId = user.id;

      // ── Fetch all user data ──
      const allMessages = [];
      let offset = 0;
      while (true) {
        const batch = await db.messages.selectAll(userId, { limit: 500, offset });
        if (!batch.length) break;
        allMessages.push(...batch);
        offset += batch.length;
        if (batch.length < 500) break;
      }

      const [docList, folders] = await Promise.all([
        db.documents.list(userId),
        db.folders.list(userId),
      ]);
      const fullDocuments = [];
      for (const doc of docList) {
        try {
          const full = await db.documents.get(userId, doc.path);
          fullDocuments.push(full || doc);
        } catch { fullDocuments.push(doc); }
      }

      const allAttachments = [];
      let attOffset = 0;
      while (true) {
        const batch = await db.attachments.listByUser(userId, { limit: 500, offset: attOffset });
        if (!batch.length) break;
        allAttachments.push(...batch);
        attOffset += batch.length;
        if (batch.length < 500) break;
      }

      const [territories, realms, semanticThemes, themeCards] = await Promise.all([
        db.rawQuery('SELECT * FROM territory_profiles WHERE user_id = ? ORDER BY energy DESC NULLS LAST', [userId]).catch(() => []),
        db.rawQuery('SELECT * FROM realms WHERE user_id = ?', [userId]).catch(() => []),
        db.rawQuery('SELECT * FROM semantic_themes WHERE user_id = ?', [userId]).catch(() => []),
        db.rawQuery('SELECT * FROM theme_cards WHERE user_id = ?', [userId]).catch(() => []),
      ]);

      const clusteringPoints = [];
      let cpOffset = 0;
      while (true) {
        const batch = await db.rawQuery(
          `SELECT id, source_type, source_id, content, atom_id, territory_id, theme_id, realm_id,
                  is_liminal, landscape_x, landscape_y, landscape_z, landscape_x_2d, landscape_y_2d,
                  cluster_version, embedding_model, created_at, updated_at
           FROM clustering_points WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000 OFFSET ?`,
          [userId, cpOffset]
        ).catch(() => []);
        if (!batch || !batch.length) break;
        clusteringPoints.push(...batch);
        cpOffset += batch.length;
        if (batch.length < 5000) break;
      }

      // Nomic 256D embeddings as hex (critical for clustering reconstruction).
      const nomicEmbeddings = {};
      try {
        let neOffset = 0;
        while (true) {
          const batch = await db.rawQuery(
            `SELECT id, hex(nomic_embedding) as nomic_hex FROM clustering_points
             WHERE user_id = ? AND nomic_embedding IS NOT NULL LIMIT 5000 OFFSET ?`,
            [userId, neOffset]
          );
          if (!batch || !batch.length) break;
          for (const row of batch) { if (row.nomic_hex) nomicEmbeddings[row.id] = row.nomic_hex; }
          neOffset += batch.length;
          if (batch.length < 5000) break;
        }
      } catch {}

      const [clusterEvents, cofiring, territoryNeighbors] = await Promise.all([
        db.clusterEvents.getRecent(userId, 10000).catch(() => []),
        db.rawQuery('SELECT * FROM territory_cofire WHERE user_id = ?', [userId]).catch(() => []),
        db.rawQuery('SELECT * FROM territory_neighbors WHERE user_id = ?', [userId]).catch(() => []),
      ]);

      const allPeople = [];
      try {
        const rows = await db.rawQuery(
          `SELECT id, name, aliases, email, phone, linkedin_url, company, position, description,
                  source, tier, status, connected_at, last_interaction_at, interaction_count,
                  sent_count, received_count, metadata, created_at
           FROM people WHERE user_id = ? ORDER BY name`,
          [userId]
        );
        allPeople.push(...(rows || []));
      } catch {}

      let contactTerritories = [];
      try {
        contactTerritories = await db.rawQuery(
          `SELECT contact_id, territory_id, strength, mention_count, first_seen, last_seen
           FROM contact_territories WHERE contact_id IN (SELECT id FROM people WHERE user_id = ?)`,
          [userId]
        );
      } catch {}

      let healthData = [];
      try { healthData = await db.health.getRange(userId, '2000-01-01', '2099-12-31'); } catch {}

      let activitySessions = [], activityDaily = [];
      try {
        activitySessions = await db.rawQuery(
          `SELECT id, app_bundle, app_name, window_title, url, category, productivity,
                  started_at, ended_at, duration_s, idle, date
           FROM activity_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50000`,
          [process.env.AGENT_ID || 'personal-agent']
        );
      } catch {}
      try {
        activityDaily = await db.rawQuery(
          `SELECT date, category, total_s, session_count, productivity_avg
           FROM activity_daily WHERE agent_id = ? ORDER BY date DESC`,
          [process.env.AGENT_ID || 'personal-agent']
        );
      } catch {}

      let wealthPortfolios = [], wealthPositions = [], wealthTransactions = [], wealthSnapshots = [], wealthAssets = [], wealthWatchlist = [];
      try {
        wealthPortfolios = await db.wealth.listPortfolios(userId).catch(() => []);
        wealthAssets = await db.rawQuery('SELECT * FROM wealth_assets').catch(() => []);
        wealthWatchlist = await db.wealth.getWatchlist(userId).catch(() => []);
        for (const p of wealthPortfolios) {
          const [pos, txs, snaps] = await Promise.all([
            db.wealth.getPositions(p.id).catch(() => []),
            db.wealth.listTransactions(p.id, { limit: 50000 }).catch(() => []),
            db.wealth.getSnapshots(p.id).catch(() => []),
          ]);
          wealthPositions.push(...pos.map(r => ({ ...r, portfolio_id: p.id })));
          wealthTransactions.push(...txs);
          wealthSnapshots.push(...snaps.map(r => ({ ...r, portfolio_id: p.id })));
        }
      } catch {}

      let userProfile = null, userSettings = {};
      try {
        const u = await db.users.getFirst();
        userSettings = { displayName: u?.display_name, timezone: u?.timezone, settings: u?.settings ? JSON.parse(u.settings) : {} };
      } catch {}
      try {
        userProfile = await db.rawQuery(
          'SELECT * FROM user_profiles WHERE user_id = ?', [userId]
        ).then(r => r?.[0] || null);
      } catch {}

      let identities = [];
      try { identities = await db.userIdentities.list(userId).catch(() => []); } catch {}

      let canvases = [];
      try { canvases = await db.canvases.list(userId).catch(() => []); } catch {}

      let tasks = [];
      try {
        tasks = await db.rawQuery(
          `SELECT id, agent_id, type, description, status, priority, result, summary, error, created_at, started_at, completed_at
           FROM agent_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 10000`,
          [userId]
        );
      } catch {}

      let internalModel = [];
      try {
        internalModel = await db.rawQuery(
          `SELECT id, section, content, reinforcement_count, status, source_cycle_id, created_at, updated_at
           FROM internal_model_items WHERE user_id = ? ORDER BY section, created_at DESC`,
          [userId]
        );
      } catch {}

      let passkeys = [];
      try { passkeys = await db.passkeys.listByUser(userId).catch(() => []); } catch {}

      let documentVersions = [];
      try {
        documentVersions = await db.rawQuery(
          'SELECT * FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE user_id = ?) ORDER BY created_at DESC',
          [userId]
        ) || [];
      } catch {}

      let canvasNodes = [], canvasEdges = [], canvasCollaborators = [];
      try {
        canvasNodes = await db.rawQuery('SELECT * FROM canvas_nodes WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)', [userId]) || [];
        canvasEdges = await db.rawQuery('SELECT * FROM canvas_edges WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)', [userId]) || [];
        canvasCollaborators = await db.rawQuery('SELECT * FROM canvas_collaborators WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)', [userId]) || [];
      } catch {}

      let connections = [];
      try { connections = await db.rawQuery('SELECT * FROM connections WHERE user_a = ? OR user_b = ?', [userId, userId]) || []; } catch {}

      let realmNeighbors = [];
      try { realmNeighbors = await db.rawQuery('SELECT * FROM realm_neighbors WHERE user_id = ?', [userId]) || []; } catch {}

      let reflections = [];
      try { reflections = await db.rawQuery('SELECT * FROM reflections WHERE user_id = ? ORDER BY created_at DESC', [userId]) || []; } catch {}

      let personalTasks = [];
      try { personalTasks = await db.rawQuery('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC', [userId]) || []; } catch {}

      let noteLinks = [];
      try { noteLinks = await db.rawQuery('SELECT * FROM note_links WHERE user_id = ?', [userId]) || []; } catch {}

      let shareLinks = [], accessGrants = [];
      try { shareLinks = await db.rawQuery('SELECT * FROM share_links WHERE entity_id IN (SELECT id FROM documents WHERE user_id = ?)', [userId]) || []; } catch {}
      try { accessGrants = await db.rawQuery('SELECT * FROM access_grants WHERE user_id = ?', [userId]) || []; } catch {}

      let aiProviders = [];
      try { aiProviders = await db.rawQuery('SELECT * FROM ai_providers WHERE user_id = ?', [userId]) || []; } catch {}

      let scheduledEvents = [];
      try { scheduledEvents = await db.rawQuery('SELECT * FROM scheduled_events WHERE user_id = ?', [userId]) || []; } catch {}

      let secrets = [];
      try { secrets = await db.rawQuery('SELECT key, scope, agent, description, version, created_at, updated_at FROM secrets WHERE user_id = ?', [userId]) || []; } catch {}

      let agentEvents = [];
      try {
        agentEvents = await db.rawQuery(
          'SELECT * FROM agent_events WHERE agent_id IN (SELECT agent FROM agent_tokens WHERE user_id = ?) ORDER BY created_at DESC LIMIT 50000',
          [userId]
        ) || [];
      } catch {}

      let cycleMetrics = [];
      try { cycleMetrics = await db.rawQuery('SELECT * FROM cycle_metrics WHERE user_id = ? ORDER BY created_at DESC', [userId]) || []; } catch {}

      // Phase 5 canonical cognitive metrics (migration 158). Read via the
      // Worker proxy — autoDecryptResults wraps the response so the
      // encrypted scalar columns are decrypted into the bundle. Same
      // pattern as wealth_* tables (encrypted at rest; exported as
      // plaintext under the user's session). Legacy fisher_trajectory /
      // cognitive_metrics_harmonic / topology_audit_snapshots /
      // complexity_snapshots / frequency_snapshots are NOT exported
      // here — they're reproducible from clustering_points + messages
      // via compute, and retire in PR 5.7 (3-4 weeks). Including them
      // would bloat bundles and create a v4-compat trap when readers
      // expect them post-PR-5.7.
      let cogMetricsWindow = [];
      let cogMetricsTrajectory = [];
      let cogMetricsPerTerritory = [];
      let topologyMetricsRows = [];
      try {
        cogMetricsWindow = await db.rawQuery(
          'SELECT * FROM cognitive_metrics_window WHERE user_id = ? ORDER BY window_end DESC',
          [userId]
        ) || [];
      } catch {}
      try {
        cogMetricsTrajectory = await db.rawQuery(
          'SELECT * FROM cognitive_metrics_trajectory WHERE user_id = ? ORDER BY window_start DESC',
          [userId]
        ) || [];
      } catch {}
      try {
        cogMetricsPerTerritory = await db.rawQuery(
          'SELECT * FROM cognitive_metrics_per_territory WHERE user_id = ? ORDER BY window_end DESC',
          [userId]
        ) || [];
      } catch {}
      try {
        topologyMetricsRows = await db.rawQuery(
          'SELECT * FROM topology_metrics WHERE user_id = ? ORDER BY computed_at DESC',
          [userId]
        ) || [];
      } catch {}

      let wealthWallets = [], wealthPortfolioAccess = [];
      try { wealthWallets = await db.rawQuery('SELECT * FROM wealth_wallets WHERE user_id = ?', [userId]) || []; } catch {}
      try { wealthPortfolioAccess = await db.rawQuery('SELECT * FROM wealth_portfolio_access WHERE user_id = ?', [userId]) || []; } catch {}

      // ── Build ZIP archive ──
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // Download R2 attachments. The Worker serveAttachment path verifies the
      // agent token's tenant matches the attachment's path prefix, so an
      // agent can only ever fetch its own customer's attachments.
      const workerUrl = getWorkerUrl();
      const workerSecret = process.env.AGENT_TOKEN;
      let attachmentsFetched = 0, attachmentsFailed = 0;

      for (const att of allAttachments) {
        if (!att.r2_key || !workerUrl) continue;
        try {
          const r2Res = await fetch(`${workerUrl}/attachments/${att.r2_key}`, {
            headers: { 'Authorization': `Bearer ${workerSecret}` },
            signal: AbortSignal.timeout(30000),
          });
          if (r2Res.ok) {
            const buf = Buffer.from(await r2Res.arrayBuffer());
            const safeName = (att.file_name || att.id).replace(/[^a-zA-Z0-9._-]/g, '_');
            zip.file(`attachments/${att.id}/${safeName}`, buf);
            att.zipPath = `attachments/${att.id}/${safeName}`;
            attachmentsFetched++;
          } else {
            att.fetchError = `HTTP ${r2Res.status}`;
            attachmentsFailed++;
          }
        } catch (e) {
          att.fetchError = e.message;
          attachmentsFailed++;
        }
      }

      // Agent filesystem (memory, mind, heartbeats, prompts, etc.)
      try {
        const agentsRoot = getAgentsRoot();
        const agentDirs = await fs.readdir(agentsRoot).catch(() => []);
        for (const agentDir of agentDirs) {
          const agentPath = path.join(agentsRoot, agentDir);
          const stat = await fs.stat(agentPath).catch(() => null);
          if (!stat || !stat.isDirectory()) continue;
          await addDirToZip(zip, agentPath, `agents/${agentDir}`);
        }
        const sharedDir = path.join(agentsRoot, '.shared');
        const sharedStat = await fs.stat(sharedDir).catch(() => null);
        if (sharedStat?.isDirectory()) {
          await addDirToZip(zip, sharedDir, 'agents/.shared');
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          '[Export] Agent dirs failed:', e.message
        );
      }

      const exportData = {
        exportedAt: new Date().toISOString(),
        version: 4,
        format: 'mycelium-vault-export',
        meta: {
          embeddingModels: {
            search: { name: 'nomic-embed-text-v1.5', dimensions: 768, provider: 'onnx-local', storage: 'd1.embedding_768' },
            clustering: { name: 'nomic-embed-text-v1.5', dimensions: 256, provider: 'onnx-local', storage: 'd1.clustering_points.nomic_embedding' },
          },
          hierarchy: 'realm → semantic_theme → territory → clustering_point',
          note: 'Embeddings live in D1 columns (search: encrypted in embedding_768, clustering: hex in nomicEmbeddings map). Vectorize is no longer used.',
        },
        user: { id: userId, ...userSettings, profile: userProfile, identities, passkeys },
        messages: { total: allMessages.length, data: allMessages },
        documents: { total: fullDocuments.length, data: fullDocuments },
        folders,
        attachments: { total: allAttachments.length, fetched: attachmentsFetched, failed: attachmentsFailed, data: allAttachments },
        mindscape: {
          territories, realms, semanticThemes, themeCards,
          clusteringPoints: { total: clusteringPoints.length, data: clusteringPoints },
          nomicEmbeddings: { total: Object.keys(nomicEmbeddings).length, note: 'hex-encoded 256D Nomic float32 vectors, keyed by clustering_point id', data: nomicEmbeddings },
          clusterEvents,
        },
        contacts: { total: allPeople.length, data: allPeople, territoryLinks: contactTerritories },
        health: healthData,
        activity: { sessions: activitySessions, daily: activityDaily },
        wealth: { portfolios: wealthPortfolios, assets: wealthAssets, positions: wealthPositions, transactions: wealthTransactions, snapshots: wealthSnapshots, watchlist: wealthWatchlist },
        canvases: { workspaces: canvases, nodes: canvasNodes, edges: canvasEdges, collaborators: canvasCollaborators },
        tasks: { agentTasks: tasks, personalTasks },
        internalModel,
        documents_meta: { versions: documentVersions, noteLinks, shareLinks, accessGrants },
        connections, reflections, aiProviders, scheduledEvents,
        secrets: { note: 'Values excluded for security — keys and metadata only', data: secrets },
        agentEvents: { total: agentEvents.length, data: agentEvents },
        cycleMetrics,
        // Phase 5 canonical cognitive metrics (v4 bundle key).
        // v3 bundles omit this key; restoreRaw treats undefined as no-op.
        cognitiveMetrics: {
          window:       cogMetricsWindow,
          trajectory:   cogMetricsTrajectory,
          perTerritory: cogMetricsPerTerritory,
          topology:     topologyMetricsRows,
        },
        topology: { realmNeighbors, cofiring, territoryNeighbors },
        wealthExtra: { wallets: wealthWallets, portfolioAccess: wealthPortfolioAccess },
      };

      const jsonStr = JSON.stringify(exportData, null, 2)
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      zip.file('manifest.json', Buffer.from(jsonStr, 'utf-8'));

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      const filename = `mycelium-export-${new Date().toISOString().slice(0, 10)}.zip`;
      const zipSizeMB = (zipBuffer.length / 1048576).toFixed(1);

      // Managed customers: upload to R2 + email signed download link + PIN.
      // The sentinel is MYA_USER_ID + AGENT_TOKEN — operator credentials no
      // longer live in agent runtime.
      const isManaged = !!(getWorkerUrl() && process.env.AGENT_TOKEN && process.env.MYA_USER_ID);

      if (isManaged) {
        try {
          const wUrl = getWorkerUrl();
          const agentToken = process.env.AGENT_TOKEN;

          const storeRes = await fetch(`${wUrl}/api/export-self`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
            body: JSON.stringify({ data: zipBuffer.toString('base64') }),
            signal: AbortSignal.timeout(60000),
          });

          if (!storeRes.ok) throw new Error(`Store failed: ${storeRes.status}`);
          const { downloadUrl, pin } = await storeRes.json();

          if (downloadUrl) {
            // Notify via self-service endpoint — Worker resolves email from
            // provisioning_jobs using the agent's tenant id; no spoofing.
            fetch(`${wUrl}/api/notify-self`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
              body: JSON.stringify({
                event: 'export_ready',
                details: { zipSizeMB, downloadUrl },
              }),
              signal: AbortSignal.timeout(5000),
            }).catch((e) => (logger.warn ? logger.warn.bind(logger) : console.warn)(
              '[Portal] export_ready notify failed:', e.message
            ));

            logEvent('security.export_completed', {
              userId: user.id, ip: req.ip, deliveryMethod: 'email',
              messageCount: allMessages.length, documentCount: fullDocuments.length,
              contactCount: allPeople.length, attachmentCount: allAttachments.length,
              attachmentsFetched, attachmentsFailed, zipSizeMB,
            });
            notifySecurity('export', req, { messageCount: allMessages.length });
            return res.json({ ok: true, method: 'email', pin, message: 'Download link sent to your email. Use the PIN below to verify.' });
          }
        } catch (e) {
          (logger.error ? logger.error.bind(logger) : console.error)(
            '[Portal] Managed export failed, falling back to download:', e.message
          );
          // Fall through to direct download.
        }
      }

      logEvent('security.export_completed', {
        userId: user.id, ip: req.ip, deliveryMethod: 'download',
        messageCount: allMessages.length, documentCount: fullDocuments.length,
        contactCount: allPeople.length, attachmentCount: allAttachments.length,
        attachmentsFetched, attachmentsFailed, zipSizeMB,
      });
      notifySecurity('export', req, { messageCount: allMessages.length });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', zipBuffer.length);
      res.send(zipBuffer);
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Portal] Export failed:', e?.message || e
      );
      logEvent('security.export_failed', { userId: 'unknown', ip: req.ip, reason: e?.message || 'unknown' });
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // ── /portal/import/vault ──────────────────────────────────────────

  router.post('/portal/import/vault', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      if (!checkDailyLimit(user.id, 'import', EXPORT_DAILY_LIMIT)) {
        return res.status(429).json({ error: 'Import limit exceeded. Maximum 3 per day.' });
      }
      if (!checkRateLimit(req, res, 'import', EXPORT_BURST_PER_MIN)) return;

      logEvent('security.import_requested', { userId: user.id, ip: req.ip });

      // Parse multipart upload (ZIP file, up to 2GB).
      const bb = Busboy({ headers: req.headers, limits: { fileSize: VAULT_UPLOAD_LIMIT_BYTES, files: 1 } });
      let fileBuffer = null;

      const parsePromise = new Promise((resolve, reject) => {
        const chunks = [];
        bb.on('file', (_fieldname, stream) => {
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
        });
        let tok = null;
        bb.on('field', (name, val) => { if (name === 'exportToken') tok = val; });
        bb.on('close', () => resolve(tok));
        bb.on('error', reject);
      });

      req.pipe(bb);
      const exportToken = await parsePromise;

      if (exportToken) {
        const entry = exportTokens.get(exportToken);
        if (!entry || entry.userId !== user.id || Date.now() - entry.createdAt > EXPORT_TOKEN_TTL) {
          exportTokens.delete(exportToken);
          return res.status(401).json({ error: 'Invalid or expired token' });
        }
        exportTokens.delete(exportToken);
      } else {
        const db2 = tryGetDb();
        if (db2) {
          const creds = await db2.passkeys.listByUser(user.id);
          if (creds?.length > 0) {
            return res.status(401).json({ error: 'Re-authentication required' });
          }
        }
      }

      if (!fileBuffer || fileBuffer.length < 100) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(fileBuffer);
      const manifestEntry = zip.file('manifest.json');
      if (!manifestEntry) {
        return res.status(400).json({ error: 'Invalid vault export: missing manifest.json' });
      }

      const manifest = JSON.parse(await manifestEntry.async('text'));
      if (manifest.format !== 'mycelium-vault-export') {
        return res.status(400).json({ error: `Unknown export format: ${manifest.format}` });
      }

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const targetUserId = user.id;
      const stats = {};

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[Import] Starting vault restore v${manifest.version} for ${targetUserId} (${manifest.messages?.total || 0} messages, ${manifest.attachments?.total || 0} attachments)`
      );

      // Restore in dependency order.
      try {
        if (manifest.user?.timezone) await db.users.updateTimezone(targetUserId, manifest.user.timezone);
        if (manifest.user?.settings) await db.users.updateSettings(targetUserId, manifest.user.settings);
      } catch {}

      stats.folders = await restoreRaw(db, targetUserId, 'folders', manifest.folders);

      if (manifest.documents?.data) {
        let docCount = 0;
        for (const doc of manifest.documents.data) {
          // PR 8a: vault restore is the one documented saveDocument
          // carve-out — it must preserve doc.id verbatim because
          // document_versions.document_id, share_links.entity_id, and
          // spaces "doc:<id>" references all FK to it. saveDocument
          // auto-generates a new id on INSERT, which would silently
          // orphan all those references. So vault stays on raw upsert
          // with an inline validatePath as the structural guard
          // (catches a tampered or malformed manifest path before it
          // hits D1) — the same guard saveDocument would have run.
          try {
            if (typeof doc?.path === 'string') {
              try { validatePath(doc.path, 'import-vault'); }
              catch (e) {
                console.error(`[Import vault] Skipping invalid path "${doc.path}":`, e.message);
                continue;
              }
            }
            await db.documents.upsert({ ...doc, user_id: targetUserId });
            docCount++;
          } catch {}
        }
        stats.documents = docCount;
      }
      stats.documentVersions = await restoreRaw(db, null, 'document_versions', manifest.documents_meta?.versions);
      stats.noteLinks = await restoreRaw(db, targetUserId, 'note_links', manifest.documents_meta?.noteLinks);

      const workerUrl = getWorkerUrl();
      const workerSecret = process.env.AGENT_TOKEN;
      stats.attachments = await restoreAttachments(db, targetUserId, manifest.attachments?.data || [], zip, workerUrl, workerSecret);

      if (manifest.messages?.data?.length) {
        const remapped = manifest.messages.data.map(m => ({ ...m, user_id: targetUserId }));
        await db.messages.insertIgnore(remapped);
        stats.messages = remapped.length;
      }

      if (manifest.contacts?.data?.length) {
        let pCount = 0;
        for (const p of manifest.contacts.data) {
          try {
            p.user_id = targetUserId;
            const cols = Object.keys(p).filter(c => p[c] !== undefined);
            await db.rawQuery(
              `INSERT OR REPLACE INTO people (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
              cols.map(c => p[c])
            );
            pCount++;
          } catch {}
        }
        stats.contacts = pCount;
      }
      stats.contactTerritories = await restoreRaw(db, null, 'contact_territories', manifest.contacts?.territoryLinks);

      stats.realms = await restoreRaw(db, targetUserId, 'realms', manifest.mindscape?.realms);
      stats.semanticThemes = await restoreRaw(db, targetUserId, 'semantic_themes', manifest.mindscape?.semanticThemes);
      stats.territories = await restoreRaw(db, targetUserId, 'territory_profiles', manifest.mindscape?.territories);
      stats.themeCards = await restoreRaw(db, targetUserId, 'theme_cards', manifest.mindscape?.themeCards);

      stats.clusteringPoints = await restoreClusteringPoints(
        db, targetUserId,
        manifest.mindscape?.clusteringPoints?.data,
        manifest.mindscape?.nomicEmbeddings?.data
      );

      stats.clusterEvents = await restoreRaw(db, null, 'cluster_events', manifest.mindscape?.clusterEvents);
      stats.cofiring = await restoreRaw(db, targetUserId, 'territory_cofire', manifest.topology?.cofiring);
      stats.territoryNeighbors = await restoreRaw(db, targetUserId, 'territory_neighbors', manifest.topology?.territoryNeighbors);
      stats.realmNeighbors = await restoreRaw(db, targetUserId, 'realm_neighbors', manifest.topology?.realmNeighbors);

      stats.health = await restoreRaw(db, targetUserId, 'health_daily', manifest.health);
      stats.activitySessions = await restoreRaw(db, null, 'activity_sessions', manifest.activity?.sessions);
      stats.activityDaily = await restoreRaw(db, null, 'activity_daily', manifest.activity?.daily);

      stats.wealthAssets = await restoreRaw(db, null, 'wealth_assets', manifest.wealth?.assets);
      stats.wealthPortfolios = await restoreRaw(db, targetUserId, 'wealth_portfolios', manifest.wealth?.portfolios);
      stats.wealthPositions = await restoreRaw(db, null, 'wealth_positions', manifest.wealth?.positions);
      stats.wealthTransactions = await restoreRaw(db, null, 'wealth_transactions', manifest.wealth?.transactions);
      stats.wealthSnapshots = await restoreRaw(db, null, 'wealth_snapshots', manifest.wealth?.snapshots);
      stats.wealthWatchlist = await restoreRaw(db, targetUserId, 'wealth_watchlist', manifest.wealth?.watchlist);
      stats.wealthWallets = await restoreRaw(db, targetUserId, 'wealth_wallets', manifest.wealthExtra?.wallets);
      stats.wealthPortfolioAccess = await restoreRaw(db, null, 'wealth_portfolio_access', manifest.wealthExtra?.portfolioAccess);

      stats.canvasWorkspaces = await restoreRaw(db, targetUserId, 'canvas_workspaces', manifest.canvases?.workspaces);
      stats.canvasNodes = await restoreRaw(db, null, 'canvas_nodes', manifest.canvases?.nodes);
      stats.canvasEdges = await restoreRaw(db, null, 'canvas_edges', manifest.canvases?.edges);
      stats.canvasCollaborators = await restoreRaw(db, null, 'canvas_collaborators', manifest.canvases?.collaborators);

      stats.agentTasks = await restoreRaw(db, targetUserId, 'agent_tasks', manifest.tasks?.agentTasks);
      stats.personalTasks = await restoreRaw(db, targetUserId, 'tasks', manifest.tasks?.personalTasks);
      stats.internalModel = await restoreRaw(db, targetUserId, 'internal_model_items', manifest.internalModel);
      stats.reflections = await restoreRaw(db, targetUserId, 'reflections', manifest.reflections);

      if (manifest.user?.profile) {
        await restoreRaw(db, targetUserId, 'user_profiles', [manifest.user.profile]);
      }
      stats.identities = await restoreRaw(db, targetUserId, 'user_identities', manifest.user?.identities);
      stats.aiProviders = await restoreRaw(db, targetUserId, 'ai_providers', manifest.aiProviders);
      stats.scheduledEvents = await restoreRaw(db, targetUserId, 'scheduled_events', manifest.scheduledEvents);

      stats.connections = await restoreRaw(db, null, 'connections', manifest.connections);
      stats.shareLinks = await restoreRaw(db, null, 'share_links', manifest.documents_meta?.shareLinks);
      stats.accessGrants = await restoreRaw(db, targetUserId, 'access_grants', manifest.documents_meta?.accessGrants);
      stats.agentEvents = await restoreRaw(db, null, 'agent_events', manifest.agentEvents?.data);
      stats.cycleMetrics = await restoreRaw(db, targetUserId, 'cycle_metrics', manifest.cycleMetrics);

      // Phase 5 canonical cognitive metrics (v4 bundles). restoreRaw
      // is a no-op on undefined (v3 bundles) — no version branching
      // required. autoEncryptParams in the Worker re-wraps encrypted
      // columns under the target user's scope/key on INSERT.
      stats.cognitiveMetricsWindow       = await restoreRaw(db, targetUserId, 'cognitive_metrics_window',       manifest.cognitiveMetrics?.window);
      stats.cognitiveMetricsTrajectory   = await restoreRaw(db, targetUserId, 'cognitive_metrics_trajectory',   manifest.cognitiveMetrics?.trajectory);
      stats.cognitiveMetricsPerTerritory = await restoreRaw(db, targetUserId, 'cognitive_metrics_per_territory', manifest.cognitiveMetrics?.perTerritory);
      stats.topologyMetrics              = await restoreRaw(db, targetUserId, 'topology_metrics',                manifest.cognitiveMetrics?.topology);

      stats.agentFiles = await restoreAgentFiles(zip);

      (logger.info ? logger.info.bind(logger) : console.log)(
        `[Import] Vault restore complete:`, JSON.stringify(stats)
      );
      logEvent('security.import_completed', { userId: targetUserId, ip: req.ip, stats });

      res.json({ ok: true, version: manifest.version, stats });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Import] Vault restore failed:', e?.message || e
      );
      logEvent('security.import_failed', { userId: 'unknown', ip: req.ip, reason: e?.message });
      res.status(500).json({ error: 'Vault restore failed: ' + (e?.message || 'unknown error') });
    }
  });

  // ── /portal/import/messages ───────────────────────────────────────

  router.post('/portal/import/messages', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { messages } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array required' });
      }
      if (messages.length > IMPORT_MESSAGE_BATCH_CAP) {
        return res.status(400).json({ error: `Max ${IMPORT_MESSAGE_BATCH_CAP} messages per batch` });
      }

      let count = 0;
      for (const msg of messages) {
        try {
          // Persistence contract — source coerced to a valid SOURCES value
          // (was previously free-form, would have failed isValidSource()).
          // Caller-supplied source wins if recognised; otherwise import_misc.
          const incoming = msg.source;
          const resolvedSource = (incoming && typeof incoming === 'string'
            && (incoming.startsWith('import_') || incoming.startsWith('discord_')))
            ? incoming
            : 'import_misc';
          await db.messages.insert({
            id: msg.id || crypto.randomUUID(),
            user_id: user.id,
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content || '',
            message_type: 'text',
            source: resolvedSource,
            metadata: typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata || {}),
            created_at: msg.created_at || new Date().toISOString(),
          });
          count++;
        } catch { /* INSERT OR IGNORE — skip duplicates */ }
      }

      res.json({ ok: true, count });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Portal] Import messages failed:', e?.message || e
      );
      res.status(500).json({ error: 'Import failed' });
    }
  });

  // ── /portal/import/documents ──────────────────────────────────────

  router.post('/portal/import/documents', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const { documents } = req.body || {};
      if (!Array.isArray(documents) || documents.length === 0) {
        return res.status(400).json({ error: 'documents array required' });
      }
      if (documents.length > IMPORT_DOCUMENT_BATCH_CAP) {
        return res.status(400).json({ error: `Max ${IMPORT_DOCUMENT_BATCH_CAP} documents per batch` });
      }

      let count = 0;
      for (const doc of documents) {
        try {
          // PR 8a: saveDocument adoption. The empty-string foot-gun
          // (`doc.path || ''` pre-PR-8a) now fails closed via B2. Caller
          // controls path/scope/createdBy/sourceType/timestamps — we
          // pass them through with safe fallbacks. Unlike vault import,
          // batch-import has no id-FK preservation requirement (no
          // document_versions / share_links co-restored), so the auto-
          // generated id is fine.
          const docScope = ALLOWED_SCOPES.has(doc.scope) ? doc.scope : 'personal';
          await saveDocument({ db }, {
            userId: user.id,
            source: 'import-batch',
            sourceType: doc.source_type || 'import',
            scope: docScope,
            createdBy: doc.created_by || 'user',
            path: doc.path,
            title: doc.title || '',
            content: doc.content || '',
            createdAt: doc.created_at || undefined,
            updatedAt: doc.updated_at || undefined,
          });
          count++;
        } catch (e) {
          if (e instanceof SaveDocumentError) {
            (logger.error ? logger.error.bind(logger) : console.error)(
              `[Portal] Batch doc refused (${e.code}): ${e.message}`,
            );
          }
          // Non-saveDocument errors (DB failures etc) stay swallowed
          // for partial-success semantics — same as pre-PR-8a empty
          // catch.
        }
      }

      res.json({ ok: true, count });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[Portal] Import documents failed:', e?.message || e
      );
      res.status(500).json({ error: 'Import failed' });
    }
  });

  // ── /portal/delete-account/auth ───────────────────────────────────
  //
  // Mirrors /portal/export/auth. Issues either a passkey challenge
  // (reauthRequired=true) or short-circuits with a session-only token
  // when the user has no passkeys.

  router.post('/portal/delete-account/auth', async (req, res) => {
    if (!checkAuthRateLimit(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const creds = await db.passkeys.listByUser(user.id);
      if (!creds || creds.length === 0) {
        const token = crypto.randomBytes(32).toString('hex');
        deletionTokens.set(token, { userId: user.id, createdAt: Date.now() });
        return res.json({ deletionToken: token, reauthRequired: false });
      }

      const userId = process.env.MYA_USER_ID;
      let hasMasterKeyOption = false;
      if (userId) {
        try {
          const rows = await db.rawQueryOwner(
            'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
            [userId, 'ready']
          );
          hasMasterKeyOption = !!rows?.[0]?.key_hash;
        } catch {}
      }

      const auth = await getAuthModule();
      const options = await auth.generateAuthOptions();
      res.json({ options, reauthRequired: true, hasMasterKeyOption });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[DeleteAccount] Auth options failed:', e.message
      );
      res.status(500).json({ error: 'Re-authentication unavailable' });
    }
  });

  // ── /portal/delete-account/verify ─────────────────────────────────

  router.post('/portal/delete-account/verify', async (req, res) => {
    if (!checkAuthRateLimit(req, res)) return;
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { credential, keyHash } = req.body || {};

      // Option A: master key hash (managed instances).
      if (keyHash) {
        if (keyHash.length !== 64 || !KEY_HASH_HEX_RE.test(keyHash)) {
          return res.status(400).json({ error: 'Invalid key hash format' });
        }
        const userId = process.env.MYA_USER_ID;
        if (!userId) return res.status(503).json({ error: 'Not available' });

        let storedHash = null;
        const workerUrl = getWorkerUrl();
        const agentToken = process.env.AGENT_TOKEN || process.env.AGENT_TOKEN_MYA;

        if (workerUrl && agentToken) {
          try {
            const wRes = await fetch(`${workerUrl}/api/db/query`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
              body: JSON.stringify({
                sql: 'SELECT key_hash FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1',
                params: [userId, 'ready'],
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (wRes.ok) {
              const data = await wRes.json();
              storedHash = data.results?.[0]?.key_hash;
            }
          } catch (e) {
            (logger.error ? logger.error.bind(logger) : console.error)(
              '[DeleteAccount] Key hash query error:', e.message
            );
          }
        }

        if (!storedHash) return res.status(404).json({ error: 'No key hash on file' });

        const a = Buffer.from(keyHash, 'hex');
        const b = Buffer.from(storedHash, 'hex');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          logEvent('security.deletion_reauth_failed', { userId: user.id, ip: req.ip, method: 'key_hash' });
          return res.status(401).json({ error: 'Invalid key' });
        }

        logEvent('security.deletion_reauth_success', { userId: user.id, ip: req.ip, method: 'key_hash' });
        const token = crypto.randomBytes(32).toString('hex');
        deletionTokens.set(token, { userId: user.id, createdAt: Date.now() });
        return res.json({ deletionToken: token });
      }

      // Option B: passkey.
      if (!credential) return res.status(400).json({ error: 'Credential or key hash required' });

      const auth = await getAuthModule();
      const result = await auth.verifyAuth(credential);

      if (!result.verified) {
        logEvent('security.deletion_reauth_failed', { userId: user.id, ip: req.ip, method: 'passkey' });
        return res.status(401).json({ error: 'Re-authentication failed' });
      }

      logEvent('security.deletion_reauth_success', { userId: user.id, ip: req.ip, method: 'passkey' });
      const token = crypto.randomBytes(32).toString('hex');
      deletionTokens.set(token, { userId: user.id, createdAt: Date.now() });
      res.json({ deletionToken: token });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[DeleteAccount] Re-auth verify failed:', e?.message || e
      );
      logEvent('security.deletion_reauth_failed', { userId: 'unknown', ip: req.ip, reason: e?.message });
      res.status(400).json({ error: 'Re-authentication failed' });
    }
  });

  // ── /portal/delete-account ────────────────────────────────────────
  //
  // GDPR-style irreversible wipe. Requires:
  //   1. Valid session (authenticatePortalRequest)
  //   2. One-time deletionToken from /verify (≤5 min old, single-use)
  //   3. Literal confirmation phrase typed by the user
  //
  // On success: purges D1 user rows, R2 attachments, Vectorize entries
  // in both indexes (tenant-scoped), plus passkeys + user_identities +
  // user_profiles. Leaves AGENT_TOKEN/agent_tokens alone so the running
  // agent stays operable. Session cookie is cleared before returning.
  //
  // Table-level failures are logged and skipped (continue purging rest)
  // — the stats object reports per-table row counts.

  router.post('/portal/delete-account', async (req, res) => {
    try {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const { deletionToken, confirmation } = req.body || {};

      if (!deletionToken || typeof deletionToken !== 'string') {
        return res.status(400).json({ error: 'deletionToken required' });
      }
      const entry = deletionTokens.get(deletionToken);
      if (!entry) {
        return res.status(401).json({ error: 'Invalid or expired deletion token' });
      }
      if (Date.now() - entry.createdAt > EXPORT_TOKEN_TTL) {
        deletionTokens.delete(deletionToken);
        return res.status(401).json({ error: 'Deletion token expired' });
      }
      if (entry.userId !== user.id) {
        return res.status(401).json({ error: 'Token/user mismatch' });
      }
      // Consume now — one-time use, even if later checks fail. Prevents
      // replay after a partial rejection.
      deletionTokens.delete(deletionToken);

      if (confirmation !== DELETION_CONFIRMATION_PHRASE) {
        logEvent('security.deletion_failed', { userId: user.id, ip: req.ip, reason: 'bad_confirmation' });
        return res.status(400).json({
          error: `Confirmation must exactly match: ${DELETION_CONFIRMATION_PHRASE}`,
        });
      }

      if (!checkDailyLimit(user.id, 'delete-account', DELETION_DAILY_LIMIT)) {
        logEvent('security.deletion_failed', { userId: user.id, ip: req.ip, reason: 'daily_limit' });
        return res.status(429).json({ error: 'Deletion limit exceeded.' });
      }
      if (!checkRateLimit(req, res, 'delete-account', DELETION_BURST_PER_MIN)) {
        logEvent('security.deletion_failed', { userId: user.id, ip: req.ip, reason: 'burst_limit' });
        return;
      }

      const db = tryGetDb();
      if (!db) return res.status(503).json({ error: 'Database not available' });

      const userId = user.id;
      logEvent('security.deletion_started', { userId, ip: req.ip, ua: req.headers['user-agent'] });
      (logger.info ? logger.info.bind(logger) : console.log)(
        `[DeleteAccount] Wiping user ${userId}`
      );

      const stats = {};
      const workerUrl = getWorkerUrl();
      const agentToken = process.env.AGENT_TOKEN || process.env.AGENT_TOKEN_MYA;

      // Phase 1 instrumentation: create operator-D1 deletion_record + walk
      // users.status state machine. Best-effort — if operator-D1 is
      // unreachable we still proceed with the wipe (the legacy contract).
      // The ledger is informational; the actual deletion is what protects
      // the user. Failures are logged + stats-recorded but never abort.
      let deletionRecordId = null;
      try {
        if (workerUrl && agentToken) {
          deletionRecordId = await createDeletionRecord({
            workerUrl, agentToken,
            userId,
            handle: user.handle || null,
            initiatedBy: userId,       // self-service (operator-initiated not yet wired)
            graceWindowSeconds: 0,     // immediate; grace window UX is Phase 5
          });
          // active → pending_deletion → purging (no grace window today)
          await transition(db, userId, STATUS.PENDING_DELETION, { deletionRecordId });
          await transition(db, userId, STATUS.PURGING);
          await markRecordStatus({ workerUrl, agentToken, deletionRecordId, status: 'purging' });
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[DeleteAccount] ledger init failed (proceeding with wipe):`, e.message
        );
      }

      // (Wave 4b 2026-05-04) Steps 1+2 deleted: Cloudflare Vectorize is
      // no longer used. Embeddings live in D1 columns (`embedding_768`,
      // `clustering_points.nomic_embedding`) and get cleaned up in Step 4
      // when D1 user-tables are wiped. Legacy customers with leftover
      // Vectorize data should purge via `wrangler vectorize delete`
      // — covered in docs once the indexes are confirmed gone.

      // ── Phase 3a: Stripe cancellation (BEFORE D1 wipe — otherwise we lose the subscription_id) ──
      try {
        const subRows = await db.rawQuery(
          `SELECT subscription_id FROM subscriptions WHERE user_id = ? AND subscription_id IS NOT NULL AND status NOT IN ('canceled','cancelled')`,
          [userId]
        );
        let stripeCancelled = 0;
        let stripeFailed = 0;
        if (subRows?.length && workerUrl && agentToken) {
          for (const row of subRows) {
            try {
              const sRes = await fetch(`${workerUrl}/api/admin/stripe-cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
                body: JSON.stringify({ subscriptionId: row.subscription_id, cancelAtPeriodEnd: false }),
                signal: AbortSignal.timeout(15000),
              });
              if (sRes.ok) stripeCancelled++;
              else stripeFailed++;
            } catch { stripeFailed++; }
          }
        }
        stats.stripeCancellations = { cancelled: stripeCancelled, failed: stripeFailed };
        if (deletionRecordId && workerUrl && agentToken) {
          await recordLedgerEntry({
            workerUrl, agentToken, deletionRecordId,
            targetKind: 'stripe_subscription',
            targetName: `user/${userId}/subscriptions`,
            attemptedCount: subRows?.length || 0,
            deletedCount: stripeCancelled,
            verified: stripeFailed === 0,
            residueCount: stripeFailed,
            error: stripeFailed > 0 ? `${stripeFailed} Stripe cancels failed` : null,
          }).catch(() => {});
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          '[DeleteAccount] Stripe cancel error:', e.message
        );
        stats.stripeCancellations = { cancelled: 0, failed: 0, error: e.message };
      }

      // ── Phase 3b: Telegram webhook unregister (BEFORE wiping bot token) ──
      try {
        const tokenRows = await db.rawQuery(
          `SELECT value FROM secrets WHERE user_id = ? AND key LIKE 'TELEGRAM_BOT_TOKEN%'`,
          [userId]
        );
        let webhookCleared = 0;
        let webhookFailed = 0;
        for (const row of tokenRows || []) {
          if (!row.value) continue;
          try {
            const tRes = await fetch(
              `https://api.telegram.org/bot${row.value}/deleteWebhook?drop_pending_updates=true`,
              { signal: AbortSignal.timeout(10000) }
            );
            if (tRes.ok) webhookCleared++;
            else webhookFailed++;
          } catch { webhookFailed++; }
        }
        stats.telegramWebhooks = { cleared: webhookCleared, failed: webhookFailed };
        if (deletionRecordId && workerUrl && agentToken) {
          await recordLedgerEntry({
            workerUrl, agentToken, deletionRecordId,
            targetKind: 'telegram_webhook',
            targetName: `bot-tokens-for-${userId}`,
            attemptedCount: tokenRows?.length || 0,
            deletedCount: webhookCleared,
            verified: webhookFailed === 0,
            residueCount: webhookFailed,
            error: webhookFailed > 0 ? `${webhookFailed} webhook unregisters failed` : null,
          }).catch(() => {});
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          '[DeleteAccount] Telegram unregister error:', e.message
        );
        stats.telegramWebhooks = { cleared: 0, failed: 0, error: e.message };
      }

      // ── Step 3: R2 attachments ──
      try {
        const rows = await db.rawQuery(
          'SELECT r2_key FROM attachments WHERE user_id = ? AND r2_key IS NOT NULL',
          [userId]
        );
        let deleted = 0, failed = 0;
        if (rows?.length && workerUrl && agentToken) {
          for (const row of rows) {
            try {
              const r = await fetch(
                `${workerUrl}/attachments/${encodeURIComponent(row.r2_key)}`,
                {
                  method: 'DELETE',
                  headers: { 'Authorization': `Bearer ${agentToken}` },
                  signal: AbortSignal.timeout(15000),
                }
              );
              if (r.ok) deleted++; else failed++;
            } catch { failed++; }
          }
        }
        stats.r2Attachments = { deleted, failed };
        // Ledger entry for R2 surface (one row aggregating the whole prefix)
        if (deletionRecordId && workerUrl && agentToken) {
          try {
            await recordLedgerEntry({
              workerUrl, agentToken, deletionRecordId,
              targetKind: 'r2_prefix',
              targetName: `attachments/${userId}/`,
              attemptedCount: (rows?.length || 0),
              deletedCount: deleted,
              verified: failed === 0,
              residueCount: failed,
              error: failed > 0 ? `${failed} R2 deletes failed` : null,
            });
          } catch (ledgerErr) {
            (logger.warn ? logger.warn.bind(logger) : console.warn)(
              '[DeleteAccount] R2 ledger entry failed:', ledgerErr.message
            );
          }
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          '[DeleteAccount] R2 purge failed:', e.message
        );
        stats.r2Attachments = { deleted: 0, failed: 0 };
        if (deletionRecordId && workerUrl && agentToken) {
          await recordLedgerEntry({
            workerUrl, agentToken, deletionRecordId,
            targetKind: 'r2_prefix',
            targetName: `attachments/${userId}/`,
            verified: false,
            error: e.message,
          }).catch(() => {});
        }
      }

      // ── Step 4: D1 user tables ──
      //
      // Ordering: children with FK-ish subqueries go first, then parent
      // rows by user_id. The Worker's D1 proxy refuses unrestricted
      // DELETE — every statement must have a WHERE clause. We always
      // supply user_id (or a subquery that scopes to user_id).
      //
      // Phase 1: every successful purge ALSO writes a deletion_ledger row
      // (operator-D1) recording the table name + delete count. Failures
      // record verified=false + the error message. The ledger is the
      // per-table traceability that lets the operator (or a GDPR
      // requester) prove what was wiped vs what errored.
      async function purge(sql, params, label) {
        let attemptedCount = null;
        let deletedCount = null;
        let error = null;
        try {
          const r = await db.rawQuery(sql, params);
          const changes = r?.meta?.changes ?? r?.changes ?? null;
          stats[label] = changes === null ? 'ok' : changes;
          deletedCount = typeof changes === 'number' ? changes : null;
        } catch (e) {
          (logger.warn ? logger.warn.bind(logger) : console.warn)(
            `[DeleteAccount] purge ${label} failed:`, e.message
          );
          stats[label] = `error: ${e.message}`;
          error = e.message;
        }
        // Ledger record (best-effort; ledger write failure shouldn't
        // mask the actual purge state — `stats[label]` is the legacy contract)
        if (deletionRecordId && workerUrl && agentToken) {
          try {
            await recordLedgerEntry({
              workerUrl, agentToken, deletionRecordId,
              targetKind: 'd1_table',
              targetName: label,
              attemptedCount,
              deletedCount,
              verified: error === null ? true : false,  // Phase 1: treat clean DELETE as verified
              residueCount: error === null ? 0 : null,
              error,
            });
          } catch (ledgerErr) {
            (logger.warn ? logger.warn.bind(logger) : console.warn)(
              `[DeleteAccount] ledger entry for ${label} failed:`, ledgerErr.message
            );
          }
        }
      }

      // Children that reference user-owned parents by id, not user_id.
      // Order matters: delete these BEFORE we delete the parents that own them,
      // because the subqueries depend on the parent rows still being present.
      await purge(
        'DELETE FROM contact_territories WHERE contact_id IN (SELECT id FROM people WHERE user_id = ?)',
        [userId], 'contact_territories');
      await purge(
        'DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE user_id = ?)',
        [userId], 'document_versions');
      await purge(
        'DELETE FROM canvas_nodes WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)',
        [userId], 'canvas_nodes');
      await purge(
        'DELETE FROM canvas_edges WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)',
        [userId], 'canvas_edges');
      await purge(
        'DELETE FROM canvas_collaborators WHERE workspace_id IN (SELECT id FROM canvas_workspaces WHERE user_id = ?)',
        [userId], 'canvas_collaborators');
      await purge(
        'DELETE FROM share_links WHERE entity_id IN (SELECT id FROM documents WHERE user_id = ?)',
        [userId], 'share_links');
      await purge(
        'DELETE FROM wealth_positions WHERE portfolio_id IN (SELECT id FROM wealth_portfolios WHERE user_id = ?)',
        [userId], 'wealth_positions');
      await purge(
        'DELETE FROM wealth_transactions WHERE portfolio_id IN (SELECT id FROM wealth_portfolios WHERE user_id = ?)',
        [userId], 'wealth_transactions');
      await purge(
        'DELETE FROM wealth_snapshots WHERE portfolio_id IN (SELECT id FROM wealth_portfolios WHERE user_id = ?)',
        [userId], 'wealth_snapshots');
      await purge(
        'DELETE FROM wealth_wallets WHERE portfolio_id IN (SELECT id FROM wealth_portfolios WHERE user_id = ?)',
        [userId], 'wealth_wallets');
      await purge(
        'DELETE FROM wealth_portfolio_access WHERE portfolio_id IN (SELECT id FROM wealth_portfolios WHERE user_id = ?) OR user_id = ?',
        [userId, userId], 'wealth_portfolio_access');
      await purge(
        'DELETE FROM context_territories WHERE context_id IN (SELECT id FROM sharing_contexts WHERE user_id = ?)',
        [userId], 'context_territories');
      await purge(
        'DELETE FROM space_invites WHERE invited_by = ?',
        [userId], 'space_invites');
      await purge(
        'DELETE FROM space_knowledge WHERE source_user_id = ?',
        [userId], 'space_knowledge');
      await purge(
        'DELETE FROM shared_spaces WHERE created_by = ?',
        [userId], 'shared_spaces');

      // Phase 2 (2026-05-21): list comes from DELETION_CATALOG so a new
      // migration MUST update the catalog (the drift-detection test in
      // packages/core/test/account-deletion/catalog.test.js fails CI if
      // a CREATE TABLE lands without a catalog entry — covered OR
      // excluded-with-reason). Single source of truth.
      //
      // userIdCol is per-table because not every user-data table uses
      // the literal 'user_id' column — identity_channels uses
      // owner_user_id, space_knowledge_history uses edited_by_user_id,
      // space_rooms uses created_by, etc.
      const d1UserTables = getD1UserTables();
      for (const t of d1UserTables) {
        if (t.via) continue;          // children handled in the FK-subquery block above
        const col = t.userIdCol;
        // Defensive: column name from catalog is allow-listed by virtue
        // of being checked into source; SQL injection not possible here.
        await purge(`DELETE FROM ${t.name} WHERE ${col} = ?`, [userId], t.name);
      }

      // connections: user could be user_a or user_b.
      await purge(
        'DELETE FROM connections WHERE user_a = ? OR user_b = ?',
        [userId, userId], 'connections');

      // Intentionally NOT deleted (each preserved for a documented reason):
      //   agent_tokens        — runtime auth for the current agent; killing it
      //                         would brick the agent before the response lands.
      //                         A follow-up fleet step can rotate/revoke it.
      //   audit_log           — retention. The security trail outlives the
      //                         account (and in particular outlives deletion).
      //   agent_events        — ops telemetry keyed by agent_id, not user_id.
      //                         Shared across users on owner D1.
      //   activity_sessions,
      //   activity_daily      — keyed by agent_id. Managed tenants have their
      //                         own D1 so these vanish with the DB; on owner
      //                         D1 we leave orphan rows since the same agent
      //                         stays in service.
      //   federation_*,
      //   handle_reservations,
      //   stripe_events,
      //   waitlist,
      //   telegram_groups     — system-level or shared ops tables.
      //   wealth_assets       — shared asset catalog (not per-user).
      //   provisioning_jobs   — operator-side fleet record; holds the key_hash
      //                         that gatekeeps deletion itself. Leave to the
      //                         fleet deprovisioning flow.
      //   deployment_log      — operator deploy history.

      // ── Phase 4: audit_log PII binding drop ──
      // We INTENTIONALLY don't delete audit_log rows (security/retention),
      // but we DO NULL out the user_id column for this user so the events
      // remain queryable while the PII linkage is severed. GDPR Article 17:
      // "controller shall, taking account of available technology and the
      // cost of implementation, take reasonable steps...to inform
      // controllers which are processing the personal data that the data
      // subject has requested the erasure of any links to..."
      try {
        const auditUpdate = await db.rawQuery(
          `UPDATE audit_log SET user_id = NULL WHERE user_id = ?`,
          [userId]
        );
        const auditChanges = auditUpdate?.meta?.changes ?? auditUpdate?.changes ?? null;
        stats.auditLogPiiDrop = auditChanges === null ? 'ok' : auditChanges;
        if (deletionRecordId && workerUrl && agentToken) {
          await recordLedgerEntry({
            workerUrl, agentToken, deletionRecordId,
            targetKind: 'd1_table',
            targetName: 'audit_log (pii_drop)',
            deletedCount: auditChanges,
            verified: true,  // NULL update is its own success
          }).catch(() => {});
        }
      } catch (e) {
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          '[DeleteAccount] audit_log PII drop failed:', e.message
        );
        stats.auditLogPiiDrop = `error: ${e.message}`;
      }

      // ── Step 5: users row (last) ──
      await purge('DELETE FROM users WHERE id = ?', [userId], 'users');

      // Phase 2: ledger-record the OPERATOR-ACTION targets that need
      // teardown but can't be invoked from the customer's auth context.
      // The deprovision-customer.sh script reads these entries and
      // completes them (KMS DELETE, DNS DELETE, tenant D1 delete, Worker
      // binding remove, Hetzner VPS destroy). Records verified=null
      // (pending) so the operator can find them post-deletion.
      if (deletionRecordId && workerUrl && agentToken) {
        const pendingTargets = [
          { kind: 'kms', name: `customer/${userId}`,
            note: 'requires admin mTLS cert; deprovision-customer.sh handles' },
          { kind: 'cloudflare_dns', name: `${user.handle || userId}.mycelium.id`,
            note: 'requires admin Worker call; deprovision-customer.sh handles' },
          { kind: 'cloudflare_d1', name: `mycelium-tenant-${user.handle || userId.slice(0,20)}`,
            note: 'requires admin wrangler; deprovision-customer.sh handles' },
          { kind: 'worker_binding', name: `DB_TENANT_${userId.replace(/-/g, '').slice(0, 32)}`,
            note: 'requires wrangler.toml edit + redeploy; deprovision-customer.sh handles' },
          { kind: 'hetzner_vps', name: `mycelium-${userId.slice(0, 20)}`,
            note: 'requires Hetzner API token; deprovision-customer.sh handles' },
          { kind: 'operator_local', name: `~/.config/mycelium-ssh/customers.yml`,
            note: 'operator-laptop only; manual or scripts/operator-cleanup.sh' },
        ];
        for (const t of pendingTargets) {
          try {
            await recordLedgerEntry({
              workerUrl, agentToken, deletionRecordId,
              targetKind: t.kind,
              targetName: t.name,
              verified: null,           // pending operator action
              error: `PENDING_OPERATOR_ACTION: ${t.note}`,
            });
          } catch (e) {
            (logger.warn ? logger.warn.bind(logger) : console.warn)(
              `[DeleteAccount] pending-ledger ${t.kind} failed:`, e.message
            );
          }
        }
      }

      // ── Step 6: clear session cookie ──
      // Match the exact header that sessionService writes (see
      // packages/server/services/session.js:67) so cookie removal is
      // bit-identical and survives browser quirks.
      res.setHeader('Set-Cookie', 'mycelium_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');

      // Partial-failure telemetry: any table whose stat is a string starting
      // with "error:" failed. Emit a distinct event so ops can alert on it
      // (completed=success, partial=manual follow-up required).
      const partialFailures = Object.entries(stats)
        .filter(([, v]) => typeof v === 'string' && v.startsWith('error:'))
        .map(([k]) => k);

      if (partialFailures.length > 0) {
        logEvent('security.deletion_partial', { userId, ip: req.ip, failedTables: partialFailures, stats });
        (logger.warn ? logger.warn.bind(logger) : console.warn)(
          `[DeleteAccount] Partial failure for ${userId}: ${partialFailures.join(', ')}`
        );
      } else {
        logEvent('security.deletion_completed', { userId, ip: req.ip, stats });
      }

      // Phase 1: final operator-D1 state. Status reflects whether every
      // recorded ledger entry verified. Note: by this point we've DELETEd
      // the users row, so users.status update is moot here — the truth is
      // in deletion_records.status from now on.
      // (We don't try to UPDATE users.status here because the row no
      // longer exists; the transition() to deleted_tombstone happens
      // implicitly via row absence + status='active' default backfill
      // for the residual row that vanished. The orchestrator pattern in
      // Phase 2 replaces this dance with explicit pre-DELETE state set.)
      if (deletionRecordId && workerUrl && agentToken) {
        try {
          await markRecordStatus({
            workerUrl, agentToken, deletionRecordId,
            status: partialFailures.length > 0 ? 'purging_partial' : 'deleted_tombstone',
            verificationPassed: partialFailures.length === 0,
            handleReleaseDays: 90,
          });
        } catch (e) {
          (logger.warn ? logger.warn.bind(logger) : console.warn)(
            `[DeleteAccount] markRecordStatus failed:`, e.message
          );
        }
      }

      notifySecurity('account_deletion', req, { userId, partial: partialFailures.length > 0 });
      (logger.info ? logger.info.bind(logger) : console.log)(
        `[DeleteAccount] ${partialFailures.length ? 'Partial' : 'Completed'} for ${userId}:`, JSON.stringify(stats)
      );

      res.json({
        ok: true,
        stats,
        partial: partialFailures.length > 0,
        deletionRecordId,  // Phase 1: enables UI to render receipt + ledger
      });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[DeleteAccount] Failed:', e?.message || e
      );
      logEvent('security.deletion_failed', { userId: 'unknown', ip: req.ip, reason: e?.message });
      res.status(500).json({ error: 'Deletion failed: ' + (e?.message || 'unknown error') });
    }
  });

  // ── GET /portal/deletion-receipt — GDPR Article 17 receipt ──
  // Returns the deletion_record + full deletion_ledger for a given
  // deletion_record_id. Public-ish: requires the deletion_record_id
  // itself as the bearer (it's an unguessable UUID returned only at
  // /portal/delete-account completion). After the account is deleted,
  // the customer no longer has a session — but they may have copied
  // the deletion_record_id from the success screen and want to verify
  // later. This endpoint serves that need.
  //
  // The endpoint does NOT require auth because the account is gone;
  // requiring auth would be impossible. Instead, the deletion_record_id
  // acts as a bearer token. Phase 5 polish: sign the response JSON
  // with VPS Ed25519 key so the receipt is independently verifiable.
  router.get('/portal/deletion-receipt', async (req, res) => {
    try {
      const deletionRecordId = String(req.query.id || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(deletionRecordId)) {
        return res.status(400).json({ error: 'id must be a UUID' });
      }
      const workerUrl = getWorkerUrl();
      const agentToken = process.env.AGENT_TOKEN || process.env.AGENT_TOKEN_MYA;
      if (!workerUrl || !agentToken) {
        return res.status(503).json({ error: 'Receipt service unavailable' });
      }
      const { record, ledger } = await fetchDeletionReport({
        workerUrl, agentToken, deletionRecordId,
      });
      if (!record) {
        return res.status(404).json({ error: 'Deletion record not found' });
      }
      // PII-safe response: handle is the only identifier (user_id is
      // already a UUID; no personal info beyond that).
      res.json({
        ok: true,
        record: {
          id: record.id,
          handle: record.handle,
          status: record.status,
          initiated_at: record.initiated_at,
          completed_at: record.completed_at,
          cancelled_at: record.cancelled_at,
          verification_passed: record.verification_passed === 1,
          handle_release_at: record.handle_release_at,
        },
        ledger: ledger.map((row) => ({
          target_kind: row.target_kind,
          target_name: row.target_name,
          attempted_count: row.attempted_count,
          deleted_count: row.deleted_count,
          verified: row.verified === 1,
          residue_count: row.residue_count,
          error: row.error,
          attempted_at: row.attempted_at,
          verified_at: row.verified_at,
        })),
        summary: {
          total_targets: ledger.length,
          verified_targets: ledger.filter(r => r.verified === 1).length,
          pending_operator: ledger.filter(r => r.verified === null && r.error?.startsWith('PENDING_OPERATOR_ACTION')).length,
          failed_targets: ledger.filter(r => r.verified === 0).length,
        },
      });
    } catch (e) {
      (logger.error ? logger.error.bind(logger) : console.error)(
        '[DeletionReceipt] Failed:', e?.message || e
      );
      res.status(500).json({ error: 'Receipt fetch failed' });
    }
  });

  (logger.info ? logger.info.bind(logger) : console.log)(
    `[${LOG_PREFIX}] portal-export-import-router mounted 10 handlers`
  );

  return router;
}
