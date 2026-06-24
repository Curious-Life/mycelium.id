// src/http/login-csrf.js — CSRF defense for the relay-exposed POST /login (H6).
//
// /login signs the operator in SERVER-SIDE (auth.api.signInEmail), which
// deliberately bypasses better-auth's HTTP-layer Origin/CSRF check — so without
// our own guard it is a login-CSRF / session-fixation vector: a cross-site page
// can auto-submit the form and drive the victim's browser through an OAuth grant.
//
// Defense (two independent layers, CLAUDE.md §2):
//   1. Same-origin: a present Origin header must match the request host.
//   2. Double-submit token: GET /login mints a random token in a SameSite=Strict
//      HttpOnly cookie AND embeds it in the form; POST requires both to match
//      (constant-time). A cross-site post has neither the cookie nor the token.
import crypto from 'node:crypto';

const COOKIE = 'myc_login_csrf';

function readCookie(req, name) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isHttps(req) {
  if (req.secure === true) return true;
  return String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function timingEq(a, b) {
  const ba = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/** Mint a CSRF token, set it as a hardened cookie, and return it for the form. */
export function issueLoginCsrf(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const secure = isHttps(req) ? '; Secure' : ''; // flagless on loopback http; Secure over the relay
  res.append('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/login; Max-Age=600${secure}`);
  return token;
}

/**
 * Verify same-origin + double-submit CSRF for POST /login.
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
export function verifyLoginCsrf(req) {
  const origin = req.headers?.origin;
  if (origin) {
    let oh; try { oh = new URL(origin).host; } catch { oh = null; }
    if (!oh || oh !== req.headers?.host) return { ok: false, reason: 'origin_mismatch' };
  }
  const cookieTok = readCookie(req, COOKIE);
  const formTok = req.body?._csrf;
  if (!timingEq(cookieTok, formTok)) return { ok: false, reason: 'csrf_mismatch' };
  return { ok: true };
}

export const LOGIN_CSRF_COOKIE = COOKIE;
