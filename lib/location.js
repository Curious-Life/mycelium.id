/**
 * Location reader — provides current location from OwnTracks data files.
 * Used by context-assembly.js to inject location awareness into agent context.
 *
 * Reads from DATA_DIR/current.json (written by owntracks-receiver.js).
 * Caches in memory with 5-minute TTL.
 */

import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.OWNTRACKS_DATA_DIR || '/home/claude/data/location';
const CACHE_TTL = 5 * 60 * 1000;

let cache = null;
let cacheTime = 0;

/**
 * Get the latest location fix.
 * Returns null if no location data or data is stale (>1 hour old).
 */
export async function getLatestLocation() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'current.json'), 'utf-8');
    const loc = JSON.parse(raw);

    // Check freshness — ignore locations older than 1 hour
    const age = now - new Date(loc.receivedAt).getTime();
    if (age > 60 * 60 * 1000) return null;

    cache = loc;
    cacheTime = now;
    return loc;
  } catch {
    return null;
  }
}

/**
 * Format location for agent context (one-line summary).
 */
export function formatLocation(loc) {
  if (!loc) return null;
  const age = Math.round((Date.now() - new Date(loc.receivedAt).getTime()) / 60000);
  const ageStr = age < 1 ? 'just now' : age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  return `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)} (${ageStr}, acc: ${loc.acc}m)`;
}
