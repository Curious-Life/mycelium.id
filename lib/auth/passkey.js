/**
 * WebAuthn/Passkey Authentication Module
 *
 * Server-side passkey management using @simplewebauthn/server.
 * Credentials and sessions stored in D1 via db abstraction layer.
 *
 * Usage:
 *   import { generateRegOptions, verifyReg, generateAuthOptions, verifyAuth } from './auth/passkey.js';
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import crypto from 'crypto';
import { getDb } from '../db.js';

// Relying Party configuration — set via env vars
const rpID = process.env.PASSKEY_RP_ID || 'localhost';
const rpName = process.env.PASSKEY_RP_NAME || 'Mycelium';
const rpOrigin = process.env.PASSKEY_RP_ORIGIN || 'http://localhost:5173';

// In-memory challenge store (short-lived, ~60s expiry)
const challenges = new Map();

function storeChallenge(key, challenge) {
  challenges.set(key, { challenge, expires: Date.now() + 120_000 });
  // Cleanup expired
  for (const [k, v] of challenges) {
    if (v.expires < Date.now()) challenges.delete(k);
  }
}

function getChallenge(key) {
  const entry = challenges.get(key);
  if (!entry || entry.expires < Date.now()) {
    challenges.delete(key);
    return null;
  }
  challenges.delete(key);
  return entry.challenge;
}

/**
 * Generate registration options for a new passkey.
 * Requires a valid registration token (generated via bot command).
 */
export async function generateRegOptions(registrationCode) {
  const db = getDb();

  // Validate registration token
  const tokenRow = await db.registrationTokens.validate(registrationCode);
  if (!tokenRow) {
    throw new Error('Invalid or expired registration code');
  }

  const userId = tokenRow.user_id;

  // Get user display info (email for userName, handle for displayName)
  let userName = userId;
  let displayName = 'Mycelium User';
  try {
    const userRows = await db.rawQuery('SELECT handle, display_name FROM users WHERE id = ? LIMIT 1', [userId]);
    const emailRows = await db.rawQuery('SELECT email FROM provisioning_jobs WHERE user_id = ? AND status = ? LIMIT 1', [userId, 'ready']);
    const handle = userRows?.[0]?.handle;
    const email = emailRows?.[0]?.email;
    userName = email || (handle ? `@${handle}` : userId);
    displayName = handle ? `@${handle}` : (userRows?.[0]?.display_name || 'Mycelium User');
  } catch {}

  // Get existing credentials to exclude
  const existing = await db.passkeys.listByUser(userId);
  const excludeCredentials = existing.map(c => ({
    id: c.credential_id,
    type: 'public-key',
    transports: ['internal', 'hybrid'],
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: new TextEncoder().encode(userId),
    userName,
    userDisplayName: displayName,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
  });

  // Store challenge keyed by registration code
  storeChallenge(`reg:${registrationCode}`, options.challenge);

  return { options, userId };
}

/**
 * Verify a registration response and store the credential.
 */
export async function verifyReg(registrationCode, credential) {
  const db = getDb();

  const tokenRow = await db.registrationTokens.validate(registrationCode);
  if (!tokenRow) {
    throw new Error('Invalid or expired registration code');
  }

  const userId = tokenRow.user_id;
  const expectedChallenge = getChallenge(`reg:${registrationCode}`);
  if (!expectedChallenge) {
    throw new Error('Challenge expired — try again');
  }

  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpID,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Registration verification failed');
  }

  const { credential: cred, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  // Store credential
  await db.passkeys.create(
    userId,
    cred.id,
    Buffer.from(cred.publicKey).toString('base64url'),
    cred.counter,
  );

  // Delete used registration token
  await db.registrationTokens.delete(registrationCode);

  // Create session
  const session = await createSession(userId);
  return { verified: true, session, userId };
}

/**
 * Generate authentication options (login).
 */
export async function generateAuthOptions() {
  // Allow discoverable credentials — no allowCredentials
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
  });

  storeChallenge(`auth:${options.challenge}`, options.challenge);
  return options;
}

/**
 * Verify an authentication response and create a session.
 */
export async function verifyAuth(credential) {
  const db = getDb();

  // Look up stored credential
  console.log('[Auth] Looking up credential.id:', credential.id?.substring(0, 30), '..., length:', credential.id?.length);
  const stored = await db.passkeys.getByCredentialId(credential.id);
  if (!stored) {
    throw new Error('Credential not recognized');
  }

  // Extract challenge from clientDataJSON to look up stored challenge
  let challengeFromClient;
  try {
    const clientData = JSON.parse(
      Buffer.from(credential.response.clientDataJSON, 'base64url').toString()
    );
    challengeFromClient = clientData.challenge;
  } catch {
    throw new Error('Invalid client data');
  }

  const storedChallenge = getChallenge(`auth:${challengeFromClient}`);
  if (!storedChallenge) {
    throw new Error('Challenge expired — try again');
  }

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: storedChallenge,
    expectedOrigin: rpOrigin,
    expectedRPID: rpID,
    credential: {
      id: stored.credential_id,
      publicKey: Buffer.from(stored.public_key, 'base64url'),
      counter: stored.counter,
    },
  });

  if (!verification.verified) {
    throw new Error('Authentication failed');
  }

  // Update counter
  await db.passkeys.updateCounter(
    stored.credential_id,
    verification.authenticationInfo.newCounter,
  );

  const session = await createSession(stored.user_id);
  return { verified: true, session, userId: stored.user_id };
}

/** Hash a session token with SHA-256 for storage. The raw token stays in the cookie. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Validate a session token and return user info.
 */
export async function validateSession(token) {
  const db = getDb();
  // Try hashed lookup first (new tokens), fall back to plaintext (legacy tokens)
  const hashed = hashToken(token);
  let row = await db.sessions.getUserByToken(hashed);
  if (!row) row = await db.sessions.getUserByToken(token); // legacy plaintext fallback
  if (!row) return null;
  return {
    id: row.user_id,
    displayName: row.display_name,
    timezone: row.timezone,
    settings: row.settings ? JSON.parse(row.settings) : {},
  };
}

/**
 * Delete a session (logout).
 */
export async function destroySession(token) {
  const db = getDb();
  const hashed = hashToken(token);
  await db.sessions.delete(hashed);
  await db.sessions.delete(token); // also clean up any legacy plaintext token
}

/**
 * Create a new session for a user. Returns { token, expiresAt }.
 * The raw token goes to the browser cookie. Only the SHA-256 hash is stored in D1.
 */
async function createSession(userId) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex'); // 256-bit session token
  const hashed = hashToken(token); // store only the hash in D1
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
  await db.sessions.create(hashed, userId, expiresAt);
  return { token, expiresAt }; // raw token returned to caller (goes into cookie)
}
