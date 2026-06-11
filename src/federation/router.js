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
    const r = await h.connect({ payload: req.body, headers: hdrs(req), ip: ipOf(req) });
    res.status(r.status).json(r.body);
  });

  router.post('/federation/connect-response', async (req, res) => {
    const r = await h.connectResponse({ payload: req.body, headers: hdrs(req), ip: ipOf(req) });
    res.status(r.status).json(r.body);
  });

  return router;
}
