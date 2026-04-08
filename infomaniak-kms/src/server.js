/**
 * Mycelium KMS Server — Split-Jurisdiction Key Management
 *
 * Swiss server (Infomaniak, Geneva) that holds customer KEKs.
 * All communication via mTLS — only VPSes with valid client certs
 * signed by our CA can connect.
 *
 * Endpoints:
 *   POST /unwrap          — Return KEK for the client cert's customer
 *   POST /wrap            — Store new KEK (admin cert only)
 *   POST /rotate          — Generate new random KEK (admin cert only)
 *   DELETE /customer/:id  — Crypto-shred: zero KEK (admin cert only)
 *   GET /health           — Status (no auth required)
 */

import https from 'https';
import { readFileSync, existsSync } from 'fs';
import express from 'express';
import helmet from 'helmet';
import {
  storeKek, getKek, hasKek, deleteKek, rotateKek,
  customerCount, getKekMeta, listCustomers,
} from './key-store.js';
import { initAudit, logAudit, queryAudit, verifyIntegrity, detectAnomalies } from './audit.js';

const app = express();

// ── Security ──
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.disable('x-powered-by');

// ── Rate limiting (in-memory, per client cert fingerprint) ──
const rateLimits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_UNWRAP = 10;  // 10/min for VPS certs

function checkRateLimit(fingerprint, limit) {
  const now = Date.now();
  let entry = rateLimits.get(fingerprint);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimits.set(fingerprint, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [fp, entry] of rateLimits) {
    if (entry.windowStart < cutoff) rateLimits.delete(fp);
  }
}, 5 * 60_000);

// ── Client cert helpers ──
function getCertInfo(req) {
  const cert = req.socket.getPeerCertificate();
  return {
    cn: cert?.subject?.CN || 'unknown',
    fingerprint: cert?.fingerprint256 || cert?.fingerprint || 'unknown',
    valid: req.client?.authorized ?? false,
  };
}

function isAdmin(req) {
  const cert = getCertInfo(req);
  return cert.cn === 'kms-admin';
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    const cert = getCertInfo(req);
    logAudit({
      customerId: req.params?.id || req.body?.customerId || 'unknown',
      action: 'error',
      certFingerprint: cert.fingerprint,
      sourceIp: req.ip,
      details: { error: 'Admin access denied', cn: cert.cn },
    });
    res.status(403).json({ error: 'Admin certificate required' });
    return false;
  }
  return true;
}

function validateCustomerId(id) {
  return id && typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(id);
}

// ── Endpoints ──

// POST /unwrap — Return KEK hex for the customer matching client cert CN
app.post('/unwrap', (req, res) => {
  const cert = getCertInfo(req);
  const customerId = cert.cn; // Customer ID comes from client cert CN, not body

  if (!validateCustomerId(customerId)) {
    return res.status(400).json({ error: 'Invalid customer ID in certificate CN' });
  }

  // Rate limit (admin exempt)
  if (!isAdmin(req) && !checkRateLimit(cert.fingerprint, RATE_LIMIT_UNWRAP)) {
    logAudit({ customerId, action: 'error', certFingerprint: cert.fingerprint, sourceIp: req.ip, details: { error: 'Rate limited' } });
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const kekHex = getKek(customerId);
  if (!kekHex) {
    logAudit({ customerId, action: 'error', certFingerprint: cert.fingerprint, sourceIp: req.ip, details: { error: 'Key not found' } });
    return res.status(404).json({ error: 'No KEK for this customer' });
  }

  const ttlHours = parseInt(req.body?.ttlHours, 10) || 72;
  const ttlSeconds = Math.min(Math.max(ttlHours, 1), 720) * 3600;

  logAudit({ customerId, action: 'unwrap', certFingerprint: cert.fingerprint, sourceIp: req.ip });

  res.json({
    kek: kekHex,
    ttl: ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
});

// POST /wrap — Store a new KEK for a customer (admin only)
app.post('/wrap', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { customerId, kek } = req.body;
  if (!validateCustomerId(customerId)) {
    return res.status(400).json({ error: 'Invalid customerId' });
  }
  if (!kek || typeof kek !== 'string' || kek.length !== 64) {
    return res.status(400).json({ error: 'KEK must be 64 hex characters' });
  }

  const cert = getCertInfo(req);

  try {
    storeKek(customerId, kek);
    logAudit({ customerId, action: 'wrap', certFingerprint: cert.fingerprint, sourceIp: req.ip });
    res.json({ ok: true });
  } catch (err) {
    logAudit({ customerId, action: 'error', certFingerprint: cert.fingerprint, sourceIp: req.ip, details: { error: err.message } });
    res.status(409).json({ error: err.message });
  }
});

// POST /rotate — Generate new random KEK (admin only)
app.post('/rotate', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { customerId } = req.body;
  if (!validateCustomerId(customerId)) {
    return res.status(400).json({ error: 'Invalid customerId' });
  }

  const cert = getCertInfo(req);

  try {
    const { oldKekHash, newKekHash } = rotateKek(customerId);
    logAudit({
      customerId, action: 'rotate', certFingerprint: cert.fingerprint, sourceIp: req.ip,
      details: { oldKekHash, newKekHash },
    });
    res.json({ ok: true, newKekHash });
  } catch (err) {
    logAudit({ customerId, action: 'error', certFingerprint: cert.fingerprint, sourceIp: req.ip, details: { error: err.message } });
    res.status(400).json({ error: err.message });
  }
});

// DELETE /customer/:id — Crypto-shred: zero KEK (admin only)
app.delete('/customer/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;

  const customerId = req.params.id;
  if (!validateCustomerId(customerId)) {
    return res.status(400).json({ error: 'Invalid customerId' });
  }

  const cert = getCertInfo(req);
  const deleted = deleteKek(customerId);

  logAudit({
    customerId, action: 'delete', certFingerprint: cert.fingerprint, sourceIp: req.ip,
    details: { deleted },
  });

  res.json({ ok: true, deleted });
});

// GET /health — No mTLS required (for uptime monitors)
app.get('/health', (_req, res) => {
  // Read server cert expiry
  let certExpiry = null;
  const certDir = process.env.KMS_CERT_DIR || '/etc/kms/certs';
  try {
    const serverCert = readFileSync(`${certDir}/server.crt`, 'utf-8');
    const match = serverCert.match(/Not After\s*:\s*(.*)/);
    if (match) certExpiry = new Date(match[1]).toISOString();
  } catch { /* cert read failed — not critical for health */ }

  const anomalies = detectAnomalies(60);
  const integrity = verifyIntegrity();

  res.json({
    status: 'ok',
    customers: customerCount(),
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage().rss,
    certExpiry,
    auditIntegrity: integrity.valid,
    anomalies: anomalies.length,
  });
});

// GET /audit — Query audit log (admin only)
app.get('/audit', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin required' });
  const entries = queryAudit({
    customerId: req.query.customerId,
    action: req.query.action,
    since: req.query.since,
    limit: parseInt(req.query.limit, 10) || 100,
  });
  res.json({ entries });
});

// GET /customers — List all customer IDs (admin only)
app.get('/customers', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin required' });
  const customers = listCustomers().map(id => ({ id, ...getKekMeta(id) }));
  res.json({ customers });
});

// ── Start server ──

const PORT = parseInt(process.env.KMS_PORT, 10) || 8443;
const CERT_DIR = process.env.KMS_CERT_DIR || '/etc/kms/certs';

// Verify cert files exist
for (const f of ['server.key', 'server.crt', 'ca.crt']) {
  if (!existsSync(`${CERT_DIR}/${f}`)) {
    console.error(`[KMS] Missing certificate: ${CERT_DIR}/${f}`);
    console.error('[KMS] Run certs/cert-gen.sh init first');
    process.exit(1);
  }
}

// Initialize audit log
initAudit();

const server = https.createServer({
  key: readFileSync(`${CERT_DIR}/server.key`),
  cert: readFileSync(`${CERT_DIR}/server.crt`),
  ca: readFileSync(`${CERT_DIR}/ca.crt`),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: 'TLSv1.3',
}, app);

server.listen(PORT, () => {
  console.log(`[KMS] Listening on port ${PORT} with mTLS (TLS 1.3)`);
  console.log(`[KMS] Certificates: ${CERT_DIR}`);
  console.log(`[KMS] Customers: ${customerCount()}`);
  console.log(`[KMS] Audit integrity: ${verifyIntegrity().valid ? 'OK' : 'BROKEN'}`);

  logAudit({ customerId: 'system', action: 'startup', details: { port: PORT, customers: customerCount() } });
});

// Graceful shutdown — zero all keys
process.on('SIGTERM', () => {
  console.log('[KMS] SIGTERM received — zeroing all keys');
  for (const id of listCustomers()) {
    deleteKek(id);
  }
  logAudit({ customerId: 'system', action: 'shutdown', details: { reason: 'SIGTERM' } });
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[KMS] SIGINT received — zeroing all keys');
  for (const id of listCustomers()) {
    deleteKek(id);
  }
  server.close(() => process.exit(0));
});
