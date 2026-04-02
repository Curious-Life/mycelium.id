#!/usr/bin/env node
/**
 * Google OAuth Setup CLI
 *
 * Interactively sets up OAuth tokens or Service Account references
 * for the Gmail + Drive MCP tools.
 *
 * Usage:
 *   node scripts/google-auth-setup.js                              # Default account (OAuth)
 *   node scripts/google-auth-setup.js --account martin             # Named account (OAuth)
 *   node scripts/google-auth-setup.js --service-account key.json   # Service account
 *   node scripts/google-auth-setup.js --service-account key.json --subject user@domain.com
 *
 * Prerequisites:
 *   1. Google Cloud Console → Create project → Enable Gmail API + Drive API
 *   2. Create OAuth 2.0 Client ID (type: Desktop app)
 *   3. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env
 */

import 'dotenv/config';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TOKENS_DIR = path.join(PROJECT_ROOT, '.google-tokens');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
].join(' ');

const REDIRECT_PORT = 9876;
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ── Arg parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
let accountId = 'default';
let serviceAccountFile = null;
let subject = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--account' && args[i + 1]) accountId = args[++i];
  if (args[i] === '--service-account' && args[i + 1]) serviceAccountFile = args[++i];
  if (args[i] === '--subject' && args[i + 1]) subject = args[++i];
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Google Auth Setup

Usage:
  node scripts/google-auth-setup.js                              # OAuth (default account)
  node scripts/google-auth-setup.js --account <name>             # OAuth (named account)
  node scripts/google-auth-setup.js --service-account <file>     # Service Account
  node scripts/google-auth-setup.js --service-account <file> --subject <email>

OAuth Prerequisites:
  1. Google Cloud Console → APIs & Services → Credentials
  2. Create OAuth 2.0 Client ID (Desktop app)
  3. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env

Service Account Prerequisites:
  1. Google Cloud Console → IAM & Admin → Service Accounts
  2. Create key → Download JSON
  3. For Gmail: Enable domain-wide delegation + set --subject to user email
`);
    process.exit(0);
  }
}

// ── Service Account mode ────────────────────────────────────────────

if (serviceAccountFile) {
  await setupServiceAccount(serviceAccountFile, subject);
  process.exit(0);
}

// ── OAuth mode ──────────────────────────────────────────────────────

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  console.error('Create OAuth credentials at: https://console.cloud.google.com/apis/credentials');
  process.exit(1);
}

await setupOAuth(accountId, clientId, clientSecret);

// ── Service Account Setup ───────────────────────────────────────────

async function setupServiceAccount(keyFile, subjectEmail) {
  const absPath = path.resolve(keyFile);

  console.log(`\nService Account Setup`);
  console.log(`Key file: ${absPath}`);
  if (subjectEmail) console.log(`Subject: ${subjectEmail}`);

  // Validate key file
  let key;
  try {
    const raw = await fs.readFile(absPath, 'utf-8');
    key = JSON.parse(raw);
  } catch (err) {
    console.error(`Cannot read key file: ${err.message}`);
    process.exit(1);
  }

  if (key.type !== 'service_account' || !key.private_key || !key.client_email) {
    console.error('Invalid service account key file (missing type, private_key, or client_email)');
    process.exit(1);
  }

  console.log(`Service account: ${key.client_email}`);

  // Save reference
  await fs.mkdir(TOKENS_DIR, { recursive: true });
  const tokenPath = path.join(TOKENS_DIR, `${accountId}.json`);
  await fs.writeFile(tokenPath, JSON.stringify({
    type: 'service_account',
    key_file: absPath,
    subject: subjectEmail || null,
    created_at: new Date().toISOString(),
  }, null, 2));

  console.log(`\nSaved to: ${tokenPath}`);

  // Test connectivity
  console.log('\nTesting...');
  try {
    const { createGoogleAuth } = await import('../lib/services/google-auth.js');
    const auth = createGoogleAuth(accountId);
    const token = await auth.getAccessToken();
    console.log(`Access token: ${token.slice(0, 20)}...`);

    // Test Gmail
    const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`Gmail API: ${gmailRes.ok ? 'OK' : `${gmailRes.status} ${await gmailRes.text()}`}`);

    // Test Drive
    const driveRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`Drive API: ${driveRes.ok ? 'OK' : `${driveRes.status} ${await driveRes.text()}`}`);

    console.log('\nSetup complete!');
  } catch (err) {
    console.error(`Test failed: ${err.message}`);
    console.log('\nToken file saved but connectivity test failed. Check:');
    console.log('- Domain-wide delegation is enabled');
    console.log('- Scopes authorized in Google Workspace admin');
    console.log('- Subject email is correct');
  }
}

// ── OAuth Setup ─────────────────────────────────────────────────────

async function setupOAuth(account, clientId, clientSecret) {
  const redirectUri = `http://localhost:${REDIRECT_PORT}/callback`;

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    });

  console.log(`\nGoogle OAuth Setup (account: ${account})`);
  console.log(`\nIf running on a remote VPS, set up SSH tunnel first:`);
  console.log(`  ssh -L ${REDIRECT_PORT}:localhost:${REDIRECT_PORT} user@your-vps\n`);
  console.log(`Open this URL in your browser:\n`);
  console.log(authUrl);
  console.log(`\nWaiting for authorization...`);

  // Start temp HTTP server for OAuth callback
  const code = await waitForCallback();

  // Exchange code for tokens
  console.log('\nExchanging auth code for tokens...');
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Token exchange failed (${res.status}): ${text}`);
    process.exit(1);
  }

  const tokens = await res.json();

  if (!tokens.refresh_token) {
    console.error('No refresh_token received. Try revoking access at https://myaccount.google.com/permissions and running again.');
    process.exit(1);
  }

  // Save tokens
  await fs.mkdir(TOKENS_DIR, { recursive: true });
  const tokenPath = path.join(TOKENS_DIR, `${account}.json`);
  await fs.writeFile(tokenPath, JSON.stringify({
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    scope: tokens.scope,
    created_at: new Date().toISOString(),
  }, null, 2));

  console.log(`\nTokens saved to: ${tokenPath}`);

  // Test
  console.log('\nTesting...');
  const testToken = tokens.access_token;

  const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1', {
    headers: { Authorization: `Bearer ${testToken}` },
  });
  console.log(`Gmail API: ${gmailRes.ok ? 'OK' : `${gmailRes.status}`}`);

  const driveRes = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=1', {
    headers: { Authorization: `Bearer ${testToken}` },
  });
  console.log(`Drive API: ${driveRes.ok ? 'OK' : `${driveRes.status}`}`);

  console.log('\nSetup complete!');
  console.log(`Add .google-tokens/ to .gitignore if not already there.`);
}

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization successful!</h1><p>You can close this tab.</p>`);
          server.close();
          resolve(code);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(REDIRECT_PORT, () => {
      // Server ready
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for authorization (5 minutes)'));
    }, 5 * 60 * 1000);
  });
}
