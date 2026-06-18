// src/federation/router.js — express wrapper around the framework-agnostic
// federation handlers (handlers.js). Mounted on the :4711 app in server-http.js
// AFTER express.json(). The /.well-known GETs inherit the existing CORS
// middleware (server-http.js:71-77); they are public by design (a DID + handle
// are safe to publish). POST /federation/connect is gated by signature
// verification inside the handler (fail closed), not by OAuth.

import express from 'express';
import { createFederationHandlers } from './handlers.js';

/**
 * @param {object} deps  see createFederationHandlers (db, userId, identity,
 *   getHost, getHandle, fetch). getHost/getHandle are read per request so a
 *   handle claimed after boot is picked up without a restart.
 * @returns {import('express').Router}
 */
export function createFederationRouter(deps) {
  const h = createFederationHandlers(deps);
  const router = express.Router();

  router.get('/.well-known/did.json', (req, res) => {
    const r = h.didJson();
    res.status(r.status).type('application/did+json').send(JSON.stringify(r.body));
  });

  router.get('/.well-known/webfinger', (req, res) => {
    const r = h.webfinger(req.query.resource);
    res.status(r.status).type('application/jrd+json').send(JSON.stringify(r.body));
  });

  // Key the rate limiter on the REAL socket peer, never a client-spoofable
  // X-Forwarded-For (M-FED-RL): XFF rotation would mint unlimited buckets and
  // defeat the cap. The handler's global backstop covers shared-proxy topologies.
  const ipOf = (req) => req.socket?.remoteAddress || '?';
  const hdrs = (req) => ({ 'x-myc-did': req.get('x-myc-did'), 'x-myc-sig': req.get('x-myc-sig') });

  router.post('/federation/connect', async (req, res) => {
    const r = await h.connect({ payload: req.body, headers: hdrs(req), ip: ipOf(req), rawBody: req.rawBody });
    res.status(r.status).json(r.body);
  });

  router.post('/federation/connect-response', async (req, res) => {
    const r = await h.connectResponse({ payload: req.body, headers: hdrs(req), ip: ipOf(req), rawBody: req.rawBody });
    res.status(r.status).json(r.body);
  });

  // Direct message from a connected peer (Tier-0c). Signature-gated in the
  // handler (fail closed), same as /connect; receiveMessage additionally
  // requires an accepted connection (403 otherwise).
  router.post('/federation/message', async (req, res) => {
    const r = await h.message({ payload: req.body, headers: hdrs(req), ip: ipOf(req), rawBody: req.rawBody });
    res.status(r.status).json(r.body);
  });

  // Share announce from a connected peer (Tier-0d): they granted/revoked us access
  // to one of their spaces/contexts. Signature-gated + accepted-connection only.
  router.post('/federation/share', async (req, res) => {
    const r = await h.share({ payload: req.body, headers: hdrs(req), ip: ipOf(req), rawBody: req.rawBody });
    res.status(r.status).json(r.body);
  });

  // Serve shared content to a verified, GRANTED peer (Tier-0e). The handler signs
  // the response body; we emit it verbatim with the signature headers so the peer
  // can verify it (no MITM). Error paths return plain JSON.
  router.post('/federation/shared-content', async (req, res) => {
    const r = await h.sharedContent({ payload: req.body, headers: hdrs(req), ip: ipOf(req), rawBody: req.rawBody });
    if (r.signedBody != null) {
      res.set('X-Myc-Did', r.did);
      res.set('X-Myc-Sig', r.sig);
      res.status(200).type('application/json').send(r.signedBody);
      return;
    }
    res.status(r.status).json(r.body);
  });

  // Presence query from a connected peer (online/offline dot). Signature-gated in
  // the handler (fail closed); the signed {state, nonce, ts} reply is emitted with
  // X-Myc-Did/X-Myc-Sig so the querier can verify it (no forged "online").
  router.post('/federation/presence', async (req, res) => {
    const r = await h.presence({ payload: req.body, headers: hdrs(req), ip: ipOf(req), rawBody: req.rawBody });
    if (r.signedBody != null) {
      res.set('X-Myc-Did', r.did);
      res.set('X-Myc-Sig', r.sig);
      res.status(200).type('application/json').send(r.signedBody);
      return;
    }
    res.status(r.status).json(r.body);
  });

  return router;
}
