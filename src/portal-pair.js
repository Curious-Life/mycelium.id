// src/portal-pair.js — QR device-pairing handshake router
// (docs/PHONE-QR-PAIRING-DESIGN-2026-07-19.md §3.1/§3.4, Unit B).
//
// The ceremony is the TRUST ROOT, so start/pending/approve/deny/devices/revoke are
// LOOPBACK-ONLY (owner physically at the Mac; a paired phone's device token can USE
// the vault but can NEVER approve a new device — v6 adversarial finding). The phone,
// unauthenticated, hits two PUBLIC endpoints (claim, result) mounted OUTSIDE /api and
// rate-limited both globally and per-pid.
//
// Pending sessions live in an in-memory Map (the ephemeral X25519 private key is a
// short-lived secret that must die with the process — never persisted). Single-use
// pid + 120 s TTL + prune-on-read.
//
// State machine:  started ──claim──▶ claimed ──approve──▶ approved
//                                          └───deny────▶ denied         (TTL ⇒ expired)

import express from 'express';
import crypto from 'node:crypto';
import { isTrustedLoopback } from './http/loopback.js';
import { newEphemeral, ecdh, deriveChannel, sealDir, openDir, resultProof, proofEquals } from './crypto/pair-channel.js';

const TTL_MS = 120_000;          // a pairing session lives 2 minutes
const MAX_PENDING = 20;          // concurrent-session cap (owner-driven, but bounded)
const PER_PID_MAX = 20;          // per-pid public-endpoint hits within TTL
const LABEL_MAX = 64;

/** In-memory pending store; single instance shared by the owner + public routers. */
function createPendingStore() {
  const sessions = new Map(); // pid(b64url) → session

  function prune() {
    const now = Date.now();
    for (const [pid, s] of sessions) if (now - s.createdAt > TTL_MS) sessions.delete(pid);
  }
  function get(pid) {
    prune();
    return typeof pid === 'string' ? sessions.get(pid) || null : null;
  }
  function hit(s) { // per-pid rate cap on the public endpoints
    const now = Date.now();
    s.hits = (s.hits || []).filter((t) => now - t < TTL_MS);
    if (s.hits.length >= PER_PID_MAX) return false;
    s.hits.push(now);
    return true;
  }
  function create() {
    prune();
    if (sessions.size >= MAX_PENDING) return null; // bounded; owner retries after TTL
    const eph = newEphemeral();
    const pidBytes = crypto.randomBytes(16);
    const pid = pidBytes.toString('base64url');
    const s = { pid, pidBytes, ephPriv: eph.priv, epkRaw: eph.epkRaw, epkB64: eph.epkB64, createdAt: Date.now(), state: 'started', hits: [] };
    sessions.set(pid, s);
    return s;
  }
  return { prune, get, hit, create, sessions };
}

/**
 * @param {{ db, userId?: string }} deps
 * @returns {{ ownerRouter: import('express').Router, publicRouter: import('express').Router }}
 */
export function createPairRouters({ db, userId = 'local-user', boxKeyAgreementPub = null } = {}) {
  if (!db?.deviceTokens) throw new Error('createPairRouters: db.deviceTokens namespace required');
  const store = createPendingStore();

  // ---- Owner (LOOPBACK-ONLY) router, mounted under /api/v1/portal ------------
  const ownerRouter = express.Router();
  // Loopback guard FIRST — reject non-local requests before parsing their body
  // (audit INT#1). Every ceremony route requires physical presence at the Mac: NOT
  // the owner static bearer, NOT a device token, NOT a session cookie — loopback only.
  ownerRouter.use('/pair', (req, res, next) => {
    if (!isTrustedLoopback(req)) return res.status(403).json({ ok: false, error: 'pairing requires local access' });
    next();
  });
  ownerRouter.use(express.json({ limit: '16kb' }));

  ownerRouter.post('/pair/start', (_req, res) => {
    const s = store.create();
    if (!s) return res.status(429).json({ ok: false, error: 'too many pending pairings; try again shortly' });
    // Returns the crypto handshake fields only; the portal UI merges these with the
    // reachable addresses from /phone-connect to build the QR.
    res.json({ ok: true, pid: s.pid, epk: s.epkB64, ttl: Math.floor(TTL_MS / 1000), sasDigits: 6 });
  });

  ownerRouter.get('/pair/pending', (_req, res) => {
    store.prune();
    const claimed = [];
    for (const s of store.sessions.values()) {
      if (s.state === 'claimed') claimed.push({ pid: s.pid, deviceLabel: s.deviceLabel, sas: s.sas, createdAt: s.createdAt });
    }
    res.json({ ok: true, pending: claimed });
  });

  ownerRouter.post('/pair/approve', async (req, res) => {
    const s = store.get(req.body?.pid);
    if (!s) return res.status(404).json({ ok: false, error: 'unknown or expired pairing' });
    if (s.state !== 'claimed') return res.status(409).json({ ok: false, error: `cannot approve from state '${s.state}'` });
    // Reserve the transition SYNCHRONOUSLY before the first await, so two concurrent
    // approves cannot both pass the guard and double-mint (audit SM#1 TOCTOU).
    s.state = 'approving';
    try {
      const { token, id } = await db.deviceTokens.mint(s.deviceLabel, userId);
      s.tokenId = id;
      // Seal a structured payload: the per-device token PLUS the box's long-term
      // X25519 keyAgreement public key, so the phone PINS the box key in-person at
      // pairing (E2E reachability Phase 1). boxKey may be null on a box that can't
      // derive it — the phone treats it as absent (back-compat). Public key, but
      // delivered authenticated under ckS2C so the phone need not trust the network.
      const payload = JSON.stringify({ v: 1, token, boxKey: boxKeyAgreementPub || undefined });
      s.sealed = sealDir(s.ckS2C, payload, s.pidBytes, 's2c'); // sealed to the phone; retained until TTL
      s.state = 'approved';
      res.json({ ok: true, deviceLabel: s.deviceLabel });
    } catch {
      s.state = 'claimed'; // restore so the owner can retry
      res.status(500).json({ ok: false, error: 'failed to mint device token' });
    }
  });

  ownerRouter.post('/pair/deny', async (req, res) => {
    const s = store.get(req.body?.pid);
    if (s) {
      // If a token was already minted (approved/approving), revoke it so a denied
      // pairing never leaves a live orphan token behind (audit SM#3).
      if (s.tokenId != null) { try { await db.deviceTokens.revoke(s.tokenId); } catch { /* best-effort */ } }
      s.state = 'denied';
      s.sealed = null;
    }
    res.json({ ok: true });
  });

  ownerRouter.get('/pair/devices', async (_req, res) => {
    try { res.json({ ok: true, devices: await db.deviceTokens.list() }); }
    catch { res.status(500).json({ ok: false, error: 'failed to list devices' }); }
  });

  ownerRouter.post('/pair/devices/:id/revoke', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'invalid device id' });
    try { await db.deviceTokens.revoke(id); res.json({ ok: true }); }
    catch { res.status(500).json({ ok: false, error: 'failed to revoke device' }); }
  });

  // ---- Public router (phone, unauthenticated), mounted at ROOT outside /api --
  // Throttled by the caller (createPathThrottle) AND per-pid here.
  const publicRouter = express.Router();
  // Body parser attached PER-ROUTE (not router-wide) because publicRouter is mounted
  // at ROOT (v.use(publicRouter)) — a router-wide express.json would run for EVERY
  // request flowing through, including large-body routes like importMessages (64mb),
  // and 413 them before they reach their own parser (audit: body-parser shadowing
  // found by verify:portal P8). Per-route scoping runs the 16kb cap only on /pair/*.
  const jsonBody = express.json({ limit: '16kb' });

  publicRouter.post('/pair/claim', jsonBody, (req, res) => {
    const { pid, phonePub, encLabel } = req.body || {};
    const s = store.get(pid);
    if (!s) return res.status(404).json({ ok: false, error: 'unknown or expired pairing' });
    if (!store.hit(s)) return res.status(429).json({ ok: false, error: 'too many attempts' });
    if (s.state !== 'started') return res.status(409).json({ ok: false, error: 'pairing already claimed' }); // single claim per pid
    if (typeof phonePub !== 'string' || !encLabel) return res.status(400).json({ ok: false, error: 'phonePub + encLabel required' });
    try {
      const shared = ecdh(s.ephPriv, phonePub); // throws on all-zero / bad key
      const phonePubRaw = Buffer.from(phonePub, 'base64url');
      const { ckC2S, ckS2C, ckProof, sas } = deriveChannel({ shared, pidBytes: s.pidBytes, epkRaw: s.epkRaw, phonePubRaw });
      // Opening encLabel PROVES the phone completed the ECDH from the real QR (it holds
      // ckC2S) — binds the claim to QR possession + gives the label confidentiality.
      const label = openDir(ckC2S, encLabel, s.pidBytes, 'c2s').toString('utf8').slice(0, LABEL_MAX) || 'device';
      Object.assign(s, { ckC2S, ckS2C, ckProof, sas, deviceLabel: label, phonePub, state: 'claimed' });
      res.json({ ok: true, state: 'claimed' });
    } catch {
      res.status(400).json({ ok: false, error: 'invalid pairing handshake' }); // fail-closed; no detail leaked
    }
  });

  // POST (not GET) so the proof-of-ck never lands in access logs / query strings (audit D2).
  publicRouter.post('/pair/result', jsonBody, (req, res) => {
    const s = store.get(req.body?.pid);
    if (!s) return res.status(404).json({ ok: false, error: 'unknown or expired pairing' });
    if (!store.hit(s)) return res.status(429).json({ ok: false, error: 'too many attempts' });
    if (s.state !== 'approved') return res.json({ ok: true, state: s.state }); // started/claimed/approving/denied — no sealed
    // Approved: hand back the sealed token ONLY to a caller that proves it holds ckProof
    // (the real phone). Retained until TTL so a pid-knower can't consume-and-DoS it.
    if (!proofEquals(req.body?.proof, resultProof(s.ckProof, s.pidBytes))) {
      return res.status(403).json({ ok: false, error: 'proof required' });
    }
    res.json({ ok: true, state: 'approved', sealed: s.sealed });
  });

  return { ownerRouter, publicRouter, _store: store };
}
