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

  router.post('/federation/connect', async (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
    // lowercase header lookup (express normalizes, but be explicit for the handler)
    const headers = { 'x-myc-did': req.get('x-myc-did'), 'x-myc-sig': req.get('x-myc-sig') };
    const r = await h.connect({ payload: req.body, headers, ip });
    res.status(r.status).json(r.body);
  });

  return router;
}
