/**
 * Health domain routes — /health, /info, /status, /wake-cycles.
 *
 * Reference implementation for the router factory pattern. Every future
 * extraction in Phase 10 copies this shape:
 *
 *   1. Factory function takes explicit deps (no module globals)
 *   2. Input validated with zod where applicable
 *   3. Business logic lives in a service (this file stays thin)
 *   4. Errors thrown as typed AppError, caught by the central handler
 *   5. Authentication gates are explicit per route
 *
 * Security notes:
 *   - /health returns a minimal shape to unauthenticated callers (for
 *     uptime monitors) and full detail to authenticated ones.
 *   - /info, /status, /wake-cycles require worker-secret authentication.
 *   - Nothing here touches user-scope data; all responses are operator-level.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  createCycle,
  updateCycle,
  pauseCycle,
  resumeCycle,
  cancelCycle,
  getCycle,
} from '@mycelium/core/scheduler.js';
import { validate } from '../middleware/validate.js';
import { InternalError, BadRequest, NotFound, Conflict } from '../lib/errors.js';

/** Query schema for /health — `?shape=full` forces full body even when unauthed (rejected). */
const HealthQuerySchema = z.object({
  // No accepted query params today, but the schema exists so future additions
  // go through validate() from day one.
}).passthrough();

/** Body schema for POST /wake-cycles — full validation runs in scheduler.createCycle. */
const CreateCycleSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(200),
  schedule: z.string().min(3).max(40),
  maxTurns: z.number().int().min(1).max(500).optional(),
  essential: z.boolean().optional(),
  enabled: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
  created_by: z.enum(['seed', 'agent', 'user']).optional(),
  purpose: z.string().max(500).optional(),
  prompt: z.string().max(8000).optional(),
  delivery_channel: z.enum(['lifecycle', 'portal', 'telegram', 'discord', 'silent']).optional(),
  delivery_target: z.string().max(200).optional(),
});

/** Body schema for PATCH /wake-cycles/:id — identical fields, all optional. */
const UpdateCycleSchema = CreateCycleSchema.partial().strict().refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'patch must include at least one field' },
);

/** Helper: map scheduler.js thrown errors to the right HTTP shape. */
function mapSchedulerError(err) {
  const msg = err?.message || String(err);
  if (/not found/i.test(msg)) return new NotFound('cycle_not_found', msg);
  if (/already exists/i.test(msg)) return new Conflict('cycle_id_conflict', msg);
  if (/density cap|built-in cycle|cannot change/i.test(msg)) return new BadRequest('cycle_invalid', msg);
  if (/Scheduler not started/i.test(msg)) return new InternalError(err, 'scheduler_not_started');
  if (/^cycle\.|schedule|delivery_channel|maxTurns|prompt|purpose|status/.test(msg)) {
    return new BadRequest('cycle_invalid', msg);
  }
  return new InternalError(err, 'scheduler_error');
}

/**
 * @param {object} deps
 * @param {import('../services/health.js').HealthService} deps.healthService
 * @param {(req: import('express').Request) => boolean} deps.isAuthedSilent
 *   — returns true for requests that carry valid worker-secret / localhost trust
 * @param {(req, res) => boolean} deps.requireAuth
 *   — writes 401 and returns false if unauth; returns true if allowed
 * @param {object} [deps.guardian] — optional vps.health-disclosure guardian for metrics
 */
export function createHealthRouter(deps) {
  if (!deps?.healthService) throw new TypeError('createHealthRouter: healthService required');
  const { healthService, isAuthedSilent, requireAuth, guardian } = deps;

  const router = Router();

  // ── GET /health ──────────────────────────────────────────────────────────
  // Mixed-use: HTML browser → portal redirect; JSON clients → status body.
  // Authenticated callers get full operational detail.
  router.get('/health', validate({ query: HealthQuerySchema }), async (req, res, next) => {
    try {
      if (req.accepts('html') && !req.accepts('json')) {
        return res.redirect(302, '/body');
      }

      const checks = await healthService.stackCheck();
      const status = healthService.overallStatus(checks);
      const isAuthed = isAuthedSilent ? isAuthedSilent(req) : false;

      // Guardian (Phase B seed): emit metric on disclosure decision.
      if (guardian) {
        await guardian.check({
          disclosure: isAuthed ? 'full' : 'minimal',
          ip: req.ip || req.socket?.remoteAddress,
          method: req.method,
          path: req.path,
        });
      }

      if (!isAuthed) {
        // Minimal shape — for uptime probes. Never leak agent/model/identity.
        return res.json({ status, timestamp: new Date().toISOString() });
      }

      // Authenticated → full operational detail.
      const [info, state] = await Promise.all([
        healthService.agentInfo(),
        healthService.runState(),
      ]);
      const identity = healthService.identity();

      return res.json({
        status,
        ...info,
        checks,
        ...(identity ? { identity } : {}),
        state,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(new InternalError(err, 'health_check_failed'));
    }
  });

  // ── GET /info ───────────────────────────────────────────────────────────
  // Worker-secret gated. Returns system prompt + context previews.
  router.get('/info', async (req, res, next) => {
    if (!requireAuth(req, res)) return; // requireAuth writes the 401 itself
    try {
      const info = await healthService.agentInfo();
      const previews = await healthService.readPromptPreviews();
      return res.json({
        agent: info.agent,
        directory: healthService.paths?.root,
        repository: healthService.paths?.repo,
        ...previews,
      });
    } catch (err) {
      next(new InternalError(err, 'info_read_failed'));
    }
  });

  // ── GET /status ─────────────────────────────────────────────────────────
  // Public — returns agent identity + task counters without secrets.
  router.get('/status', async (_req, res, next) => {
    try {
      const summary = await healthService.statusSummary();
      return res.json(summary);
    } catch (err) {
      next(new InternalError(err, 'status_failed'));
    }
  });

  // ── GET /wake-cycles ────────────────────────────────────────────────────
  router.get('/wake-cycles', async (_req, res, next) => {
    try {
      const cycles = await healthService.wakeCycles();
      return res.json(cycles);
    } catch (err) {
      next(new InternalError(err, 'wake_cycles_failed'));
    }
  });

  // ── GET /wake-cycles/:id — inspect one cycle ────────────────────────────
  router.get('/wake-cycles/:id', (req, res, next) => {
    try {
      const cycle = getCycle(req.params.id);
      if (!cycle) return next(new NotFound('cycle_not_found'));
      return res.json(cycle);
    } catch (err) { next(new InternalError(err, 'wake_cycle_get_failed')); }
  });

  // ── POST /wake-cycles — create a new cycle ──────────────────────────────
  router.post('/wake-cycles', validate({ body: CreateCycleSchema }), async (req, res, next) => {
    if (requireAuth && !requireAuth(req, res)) return;
    try {
      const row = await createCycle(req.body);
      return res.status(201).json(row);
    } catch (err) { next(mapSchedulerError(err)); }
  });

  // ── PATCH /wake-cycles/:id — partial update ─────────────────────────────
  router.patch('/wake-cycles/:id', validate({ body: UpdateCycleSchema }), async (req, res, next) => {
    if (requireAuth && !requireAuth(req, res)) return;
    try {
      const row = await updateCycle(req.params.id, req.body);
      return res.json(row);
    } catch (err) { next(mapSchedulerError(err)); }
  });

  // ── POST /wake-cycles/:id/{pause,resume,cancel} ─────────────────────────
  router.post('/wake-cycles/:id/pause', async (req, res, next) => {
    if (requireAuth && !requireAuth(req, res)) return;
    try { return res.json(await pauseCycle(req.params.id)); }
    catch (err) { next(mapSchedulerError(err)); }
  });
  router.post('/wake-cycles/:id/resume', async (req, res, next) => {
    if (requireAuth && !requireAuth(req, res)) return;
    try { return res.json(await resumeCycle(req.params.id)); }
    catch (err) { next(mapSchedulerError(err)); }
  });
  router.post('/wake-cycles/:id/cancel', async (req, res, next) => {
    if (requireAuth && !requireAuth(req, res)) return;
    try { return res.json(await cancelCycle(req.params.id)); }
    catch (err) { next(mapSchedulerError(err)); }
  });

  return router;
}
