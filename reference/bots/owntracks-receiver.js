#!/usr/bin/env node
/**
 * OwnTracks HTTP Receiver — Location Tracking
 *
 * Receives location updates from OwnTracks iOS/Android app via HTTP mode.
 * Stores current location + daily history as JSON files.
 *
 * OwnTracks app config:
 *   Mode: HTTP
 *   URL:  https://in.mycelium.id/webhook/owntracks
 *   Auth: Basic (username + password)
 *
 * Config (env vars):
 *   OWNTRACKS_PORT       — HTTP port (default: 5020)
 *   OWNTRACKS_USERNAME   — Basic auth username
 *   OWNTRACKS_PASSWORD   — Basic auth password
 *   OWNTRACKS_DATA_DIR   — Location data directory
 */

import 'dotenv/config';
import { bootstrapSecrets } from '@mycelium/core/bootstrap-secrets.js';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

await bootstrapSecrets();

const PORT = parseInt(process.env.OWNTRACKS_PORT || '5020');
const USERNAME = process.env.OWNTRACKS_USERNAME;
const PASSWORD = process.env.OWNTRACKS_PASSWORD;
const DATA_DIR = process.env.OWNTRACKS_DATA_DIR || '/home/claude/data/location';

if (!USERNAME) {
  console.error('[OwnTracks] OWNTRACKS_USERNAME not set. Refusing to start with a hardcoded default.');
  process.exit(1);
}
if (!PASSWORD) {
  console.error('[OwnTracks] OWNTRACKS_PASSWORD not set. Exiting.');
  process.exit(1);
}

// Ensure data directory exists
await fs.mkdir(DATA_DIR, { recursive: true });

// Rate limit: max 1 update per 5 seconds
let lastUpdate = 0;

function verifyAuth(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  // Timing-safe comparison
  const userOk = user === USERNAME;
  const passA = Buffer.from(pass || '');
  const passB = Buffer.from(PASSWORD);
  if (passA.length !== passB.length) return false;
  return userOk && crypto.timingSafeEqual(passA, passB);
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'owntracks' }));
    return;
  }

  // Current location (for agents to query)
  if (req.method === 'GET' && req.url === '/current') {
    try {
      const data = await fs.readFile(path.join(DATA_DIR, 'current.json'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"No location data"}');
    }
    return;
  }

  // OwnTracks POST
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  if (!verifyAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"Unauthorized"}');
    return;
  }

  // Rate limit
  const now = Date.now();
  if (now - lastUpdate < 5000) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end('[]'); // OwnTracks expects array response
    return;
  }
  lastUpdate = now;

  // Read body
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const payload = JSON.parse(body);

    // OwnTracks sends _type: "location" for position updates
    if (payload._type !== 'location') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }

    const location = {
      lat: payload.lat,
      lon: payload.lon,
      alt: payload.alt,
      acc: payload.acc, // accuracy in meters
      vel: payload.vel, // velocity km/h
      batt: payload.batt, // battery %
      conn: payload.conn, // connectivity (w=wifi, m=mobile)
      tid: payload.tid, // tracker ID
      tst: payload.tst, // timestamp (unix)
      receivedAt: new Date().toISOString(),
    };

    // Save current location
    await fs.writeFile(
      path.join(DATA_DIR, 'current.json'),
      JSON.stringify(location, null, 2),
    );

    // Append to daily history
    const date = new Date().toISOString().split('T')[0];
    await fs.appendFile(
      path.join(DATA_DIR, `history-${date}.jsonl`),
      JSON.stringify(location) + '\n',
    );

    console.log(`[OwnTracks] ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)} (acc: ${location.acc}m, batt: ${location.batt}%)`);

    // OwnTracks expects array response (can include friends' locations)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  } catch (err) {
    console.error('[OwnTracks] Parse error:', err.message);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('[]');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[OwnTracks] Listening on 127.0.0.1:${PORT}`);
  console.log(`[OwnTracks] Data dir: ${DATA_DIR}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
