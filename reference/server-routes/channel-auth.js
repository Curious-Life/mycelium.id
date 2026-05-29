/**
 * Channel-auth routes — multi-channel identity dispatcher.
 *
 * Mount at `/portal/auth/channel`. Three endpoints:
 *
 *   GET  /portal/auth/channel/methods         — list registered verifiers
 *   POST /portal/auth/channel/:kind/start     — begin OTP-style flow
 *   POST /portal/auth/channel/:kind           — verify proof + issue session
 *
 * Architecture: this router is a pure dispatcher. Per-protocol cryptography
 * (HMAC, OTP digest, signature check, replay protection) lives in verifier
 * modules registered into a VerifierRegistry. Phase 1 ships the dispatcher;
 * Phase 2 onwards register concrete verifiers.
 *
 * Auth posture (matches /auth/passkey/*):
 *   - Public-by-design (this IS the login endpoint)
 *   - Rate-limited per IP before any crypto work
 *   - No worker-secret gate (would break Caddy custom-domain deployments)
 *
 * Side effects on successful verify:
 *   - identity_channels row upserted/refreshed
 *   - Full session OR visitor session issued (depending on owner_user_id)
 *   - Audit log entry (fire-and-forget)
 *
 * Cookies:
 *   - Bound channel  → mycelium_session (HttpOnly, SameSite=Lax, Secure prod, 7d)
 *   - Unbound channel → mycelium_visitor_session (same flags, 24h)
 *
 * Per IDENTITY-CHANNELS.md §3.4 + §3.5.
 */

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { BadRequest } from '../lib/errors.js';
import { upsertChannelBinding } from '../services/channel-auth/upsert-channel.js';
import {
  issueForChannel,
  VISITOR_COOKIE_NAME,
  DEFAULT_TTL_MS as VISITOR_TTL_MS,
} from '../services/channel-auth/visitor-session.js';
import { UnknownChannelKind, ChannelVerificationError } from '../services/channel-auth/index.js';

// :kind in the URL — matches verifier `kind` field. Conservative whitelist
// shape; any specific allowlist is implicit via registry.has(kind).
const KIND_SHAPE = /^[a-z][a-z0-9-]{1,63}$/;

const KindParamsSchema = z.object({
  kind: z.string().regex(KIND_SHAPE, 'invalid_channel_kind'),
});

// Verify payload is verifier-specific; we accept any object and pass it
// through. Verifiers do their own validation.
const VerifyBodySchema = z.object({
  payload: z.unknown().refine((v) => v && typeof v === 'object', 'payload must be an object'),
});

const StartBodySchema = z.object({
  payload: z.unknown().refine((v) => v && typeof v === 'object', 'payload must be an object'),
});

/**
 * @typedef {object} ChannelAuthRouterDeps
 * @property {import('../services/channel-auth/index.js').VerifierRegistry} registry
 * @property {() => object|null} tryGetDb
 * @property {import('../services/auth-rate-limit.js').AuthRateLimitService} rateLimiter
 * @property {import('../services/session.js').SessionService} sessionService
 * @property {object} [auditLogger]   — { log({action, userId, ip, ...}) }
 * @property {(userId: string, opts: object) => Promise<{token: string, expiresAt: string}>} [sessionIssuer]
 *   — optional full-session minter for users with bound channels. Phase 1
 *   omits this; Phase 2 wires it once SessionService exposes a userId-only
 *   `issueForUserId` primitive.
 * @property {(name: string, value: string, opts: object) => string} [cookieString]
 *   — optional cookie-string builder; defaults to a minimal in-route impl
 * @property {object} [log]
 */

/** Build the channel-auth router. Mount at `/portal/auth/channel`. */
export function createChannelAuthRouter(deps) {
  if (!deps?.registry)       throw new TypeError('createChannelAuthRouter: registry required');
  if (!deps?.tryGetDb)       throw new TypeError('createChannelAuthRouter: tryGetDb required');
  if (!deps?.rateLimiter)    throw new TypeError('createChannelAuthRouter: rateLimiter required');
  if (!deps?.sessionService) throw new TypeError('createChannelAuthRouter: sessionService required');

  const {
    registry,
    tryGetDb,
    rateLimiter,
    sessionService,
    auditLogger = null,
    log = { info: () => {}, warn: () => {}, error: () => {} },
  } = deps;

  const router = Router();

  // Fire-and-forget audit. Audit failures must never break auth.
  function audit(action, req, extras = {}) {
    if (!auditLogger?.log) return;
    Promise.resolve(
      auditLogger.log({
        action,
        ip: req.ip,
        resourceType: 'channel-auth',
        ...extras,
      }),
    ).catch(() => {});
  }

  // ── GET /portal/auth/channel/methods ────────────────────────────────
  // Public discovery. Returns the list of registered verifier kinds so the
  // portal /login page can render the appropriate buttons.
  router.get('/methods', (_req, res) => {
    res.json({ methods: registry.list() });
  });

  // ── POST /portal/auth/channel/:kind/start ───────────────────────────
  // OTP-style flows that need a server-side challenge issued before the
  // client can produce a proof (email OTP, phone OTP, mycelium-handle).
  // Verifiers without startsFlow=true return 400.
  router.post(
    '/:kind/start',
    validate({ params: KindParamsSchema, body: StartBodySchema }),
    async (req, res, next) => {
      try {
        rateLimiter.enforce(req.ip);
        const { kind } = req.valid.params;
        const { payload } = req.valid.body;

        if (!registry.has(kind)) {
          audit('channel_auth.start_unknown_kind', req, { details: { kind } });
          throw new UnknownChannelKind(kind);
        }

        const result = await registry.start(kind, payload, {
          db: tryGetDb(),
          env: process.env,
          ipAddress: req.ip,
          // Forwarded for verifiers that need to derive a portal-origin
          // server-side (e.g. telegram-widget builds an OAuth return_to
          // URL). Prefer the explicit Origin header; fall back to the
          // Host the request landed on. Both are server-derived; clients
          // cannot redirect Telegram to an attacker-controlled URL.
          requestOrigin:
            req.headers?.origin ||
            (req.headers?.host ? `${req.protocol || 'https'}://${req.headers.host}` : undefined),
        });

        audit('channel_auth.start', req, { details: { kind } });
        res.json({ ok: true, ...result });
      } catch (err) {
        audit('channel_auth.start_failed', req, {
          details: { reason: String(err?.message || 'unknown').slice(0, 100) },
        });
        next(err);
      }
    },
  );

  // ── POST /portal/auth/channel/:kind ─────────────────────────────────
  // Verify the proof. On success, upsert the identity_channels binding and
  // issue a session (full if owner_user_id set; visitor otherwise). Return
  // a JSON body suitable for the client to update its UI.
  router.post(
    '/:kind',
    validate({ params: KindParamsSchema, body: VerifyBodySchema }),
    async (req, res, next) => {
      try {
        rateLimiter.enforce(req.ip);
        const { kind } = req.valid.params;
        const { payload } = req.valid.body;

        if (!registry.has(kind)) {
          audit('channel_auth.verify_unknown_kind', req, { details: { kind } });
          throw new UnknownChannelKind(kind);
        }

        // 1. Verifier proves control of the channel.
        const proof = await registry.verify(kind, payload, {
          db: tryGetDb(),
          env: process.env,
          ipAddress: req.ip,
        });

        // 2. Write/refresh the identity_channels binding. The verifier may
        //    return owner_user_id directly (if it can resolve from the proof,
        //    e.g., DID), but most verifiers leave owner_user_id resolution
        //    to upsertChannelBinding (look up existing row).
        const db = tryGetDb();
        const upsertResult = await upsertChannelBinding(
          { db, audit: auditLogger?.log, log },
          {
            channel_kind: proof.channel_kind,
            channel_value: proof.channel_value,
            owner_user_id: proof.owner_user_id ?? null,
            display_name: proof.display_name ?? null,
            evidence_json: proof.evidence ? JSON.stringify(proof.evidence) : null,
          },
        );

        const ownerUserId = upsertResult.row?.owner_user_id ?? null;

        // 3. Issue a session.
        //
        //    Phase 1 ships the dispatcher with VISITOR-SESSION minting only.
        //    Full-session minting (mycelium_session cookie + sessions table)
        //    is locked inside core/auth/passkey.verifyAuth and is not yet
        //    extracted as a userId-only primitive. Phase 2 (Telegram
        //    verifier) will need a `sessionIssuer` dep — ship that
        //    extraction alongside the first concrete verifier.
        //
        //    For Phase 1: we always mint a visitor session, with
        //    owner_user_id set if the channel is bound. The visitor cookie
        //    grants visitor scope only — it does NOT bypass /portal/* gates
        //    that look for mycelium_session. Promotion to a full session
        //    happens in Phase 2 via `sessionIssuer`.
        let session_kind = 'visitor';
        if (ownerUserId && typeof deps.sessionIssuer === 'function') {
          const userSession = await deps.sessionIssuer(ownerUserId, { ip: req.ip });
          sessionService.writeCookie(res, userSession.token);
          if (typeof sessionService.writeCsrfCookie === 'function') {
            sessionService.writeCsrfCookie(res);
          }
          session_kind = 'user';
          audit('channel_auth.session_issued', req, {
            userId: ownerUserId,
            details: { kind: proof.channel_kind, session_kind: 'user' },
          });
          res.json({
            ok: true,
            session_kind: 'user',
            user_id: ownerUserId,
            channel: {
              kind: proof.channel_kind,
              display_name: proof.display_name ?? null,
            },
          });
          return;
        }

        // Visitor session path (Phase 1 always; Phase 2+ when no
        // sessionIssuer or no owner_user_id).
        const visitor = await issueForChannel(
          { db, now: () => new Date() },
          {
            channel_kind: proof.channel_kind,
            channel_value: proof.channel_value,
            owner_user_id: ownerUserId,
            display_name: proof.display_name ?? null,
          },
        );
        writeVisitorCookie(res, visitor.token);
        audit('channel_auth.session_issued', req, {
          userId: ownerUserId,
          details: { kind: proof.channel_kind, session_kind },
        });
        res.json({
          ok: true,
          session_kind,
          owner_user_id: ownerUserId,
          expires_at: visitor.expires_at,
          channel: {
            kind: proof.channel_kind,
            display_name: proof.display_name ?? null,
          },
        });
      } catch (err) {
        // Channel verification failures are surfaced as 400 with a generic
        // reason; per-protocol detail goes to the audit log only.
        audit('channel_auth.verify_failed', req, {
          details: {
            kind: req.params?.kind,
            reason: String(err?.message || err?.reason || 'unknown').slice(0, 100),
          },
        });
        // Map verifier-level errors to BadRequest if they leaked through as
        // raw Errors (not AppError subclasses). Other AppError types (e.g.,
        // TooManyRequests from the rate limiter, Conflict from upsert) pass
        // through unchanged so they hit the error handler with their real
        // status code.
        if (!err?.isAppError) {
          return next(new ChannelVerificationError('channel_verification_failed'));
        }
        next(err);
      }
    },
  );

  return router;
}

/**
 * Minimal visitor cookie writer. Mirrors the policy of the user session
 * cookie (HttpOnly, SameSite=Lax, Secure in prod, Path=/) but uses the
 * visitor cookie name and a 24h Max-Age.
 */
function writeVisitorCookie(res, token) {
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.SECURE_COOKIES === '1' ||
    process.env.SECURE_COOKIES === 'true';

  const parts = [
    `${VISITOR_COOKIE_NAME}=${token}`,
    `Max-Age=${Math.floor(VISITOR_TTL_MS / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');

  // Append rather than set — the user session cookie may already be set.
  const existing = res.getHeader('Set-Cookie');
  const cookie = parts.join('; ');
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else if (existing) {
    res.setHeader('Set-Cookie', [existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}
