/**
 * Typed Event Logging
 *
 * Structured events with nested payload, trace context, and daily rotation.
 * At 6+ agents, unstructured logs become noise within hours.
 *
 * Events are typed — unknown types trigger a warning. Payloads are nested
 * under a `payload` key for clean jq filtering:
 *   jq 'select(.type == "spawn.start") | .payload.role'
 *
 * Backward compatible: the old `logEvent(type, data)` signature still works.
 * New signature: `logEvent(runtime, type, payload)` adds trace context.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { tryGetDb } from './db.js';

// Shared events directory
const AGENTS_ROOT = process.env.AGENTS_ROOT || path.join(os.homedir(), 'agents');
const EVENTS_DIR = path.join(AGENTS_ROOT, '.shared', 'events');

// Keep events for 7 days
const RETENTION_DAYS = 7;

/**
 * Known event types with required payload fields.
 * Unknown types still log (with a console warning) — this is validation, not enforcement.
 */
const EVENT_TYPES = {
  // Message lifecycle
  'message.received':              { required: ['source', 'messageId'] },
  'message.sent':                  { required: ['destination', 'messageId'] },

  // Delegation
  'delegation.created':            { required: ['targetAgent', 'taskId', 'priority'] },
  'delegation.callback':           { required: ['taskId', 'status', 'fromAgent'] },
  'delegation.timeout':            { required: ['taskId', 'targetAgent'] },
  'delegation.target_unavailable': { required: ['targetAgent'] },
  'delegation.received_remote':    { required: ['taskId', 'from', 'fromInstance'] },

  // Spawn (ephemeral sub-tasks)
  'spawn.start':                   { required: ['parentAgentId', 'role', 'model'] },
  'spawn.complete':                { required: ['parentAgentId', 'role', 'resultLength'] },
  'spawn.error':                   { required: ['parentAgentId', 'role', 'error'] },

  // Think cycle
  'think.start':                   { required: ['trigger'] },
  'think.complete':                { required: ['trigger', 'durationMs'] },
  'think.error':                   { required: ['trigger', 'error'] },

  // Health
  'health.check':                  { required: ['status'] },

  // Wake events (legacy compat)
  'wake_request':                  {},
  'wake_coalesced':                {},
  'wake_start':                    {},
  'wake_complete':                 {},
  'wake_silent':                   {},
  'wake_error':                    {},

  // Task events (legacy compat)
  'task_created':                  {},
  'task_start':                    {},
  'task_complete':                 {},
  'task_failed':                   {},
  'task_blocked':                  {},

  // Model events (legacy compat)
  'model_call':                    {},
  'model_success':                 {},
  'model_fallback':                {},
  'model_error':                   {},

  // Security audit
  'security.export_requested':     { required: ['userId', 'ip'] },
  'security.export_completed':     { required: ['userId', 'ip', 'deliveryMethod'] },
  'security.export_failed':        { required: ['userId', 'ip', 'reason'] },
  'security.reauth_success':       { required: ['userId', 'ip'] },
  'security.reauth_failed':        { required: ['userId', 'ip'] },

  // System events (legacy compat)
  'startup':                       {},
  'shutdown':                      {},
  'error':                         {},
  'cooldown_set':                  {},
  'cooldown_clear':                {},
  'profile_broken':                {},
  'lane_enqueue':                  {},
  'lane_start':                    {},
  'lane_complete':                 {},
};

/**
 * Get the current events file path (rotated daily)
 */
function getEventsFile() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(EVENTS_DIR, `events-${date}.jsonl`);
}

/**
 * Log a typed event
 *
 * Supports two calling signatures for backward compatibility:
 *
 * New (with runtime context):
 *   logEvent(runtime, 'delegation.created', { targetAgent: 'ada', taskId: '123', priority: 'high' })
 *
 * Legacy (no runtime):
 *   logEvent('wake_start', { agentId: 'mya', reason: 'heartbeat' })
 *
 * @param {Object|string} runtimeOrType - Runtime context object or event type string (legacy)
 * @param {string|Object} typeOrData - Event type string (new) or event data object (legacy)
 * @param {Object} [payload] - Nested payload (new signature only)
 */
export async function logEvent(runtimeOrType, typeOrData, payload) {
  let event;

  if (typeof runtimeOrType === 'string') {
    // Legacy signature: logEvent(type, data)
    const type = runtimeOrType;
    const data = typeOrData || {};

    event = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      type,
      ...data,
    };
  } else {
    // New signature: logEvent(runtime, type, payload)
    const runtime = runtimeOrType;
    const type = typeOrData;

    if (!EVENT_TYPES[type]) {
      console.warn(`[Events] Unknown event type: ${type}`);
    }

    // Enforce required fields per EVENT_TYPES schema
    const schema = EVENT_TYPES[type];
    if (schema?.required && Array.isArray(schema.required)) {
      const p = payload || {};
      for (const field of schema.required) {
        if (p[field] === undefined || p[field] === null) {
          console.warn(`[Events] Event ${type} missing required field: ${field}`);
          // Don't throw — log for visibility but write the event anyway with the gap
        }
      }
    }

    event = {
      ts: Date.now(),
      type,
      traceId: runtime.traceId,
      spanId: `span_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      parentSpanId: runtime.parentSpanId,
      agentPath: runtime.agentPath,
      agentId: runtime.agentId,
      payload: payload || {},
    };

    // Fire-and-forget to database if available
    const db = tryGetDb();
    if (db) db.events.insert(event);
  }

  try {
    await fs.mkdir(EVENTS_DIR, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    // Limit individual event size to prevent log poisoning
    if (line.length > 65536) {
      console.warn(`[Events] Event too large (${line.length} bytes), truncating payload`);
      event.payload = { _truncated: true, _originalSize: line.length };
    }
    await fs.appendFile(getEventsFile(), JSON.stringify(event) + '\n');
  } catch (error) {
    console.error('[Events] Failed to log event:', error.message);
  }
}

/**
 * Read recent events
 *
 * @param {Object} options
 * @param {number} options.limit - Max events to return (default: 100)
 * @param {string} options.type - Filter by event type (optional)
 * @param {string} options.agentId - Filter by agent (optional)
 * @param {number} options.since - Only events after this timestamp (optional)
 * @returns {Promise<Array>} Array of events
 */
/**
 * Validate event shape — defensive check on read.
 * Rejects malformed events that could be injected by a compromised
 * spore writing directly to the JSONL file.
 *
 * Required: object with `type` (string), `ts` (number).
 * Type must be a known EVENT_TYPES key OR start with allowlisted prefix.
 * Returns null if invalid (caller skips).
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 64) return null;
  if (typeof event.ts !== 'number' || event.ts < 0 || event.ts > Date.now() + 60000) return null;
  // Optional string fields — must be strings if present
  for (const f of ['agentId', 'traceId', 'spanId', 'parentSpanId', 'agentPath', 'iso']) {
    if (event[f] !== undefined && typeof event[f] !== 'string') return null;
    if (typeof event[f] === 'string' && event[f].length > 256) return null;
  }
  // payload must be an object if present (not array, not primitive)
  if (event.payload !== undefined && (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload))) {
    return null;
  }
  return event;
}

export async function readEvents(options = {}) {
  const { limit = 100, type, agentId, since } = options;
  const events = [];

  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    for (const date of [yesterday, today]) {
      const filePath = path.join(EVENTS_DIR, `events-${date}.jsonl`);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);

        for (const line of lines) {
          // Limit line size to prevent memory exhaustion via giant lines
          if (line.length > 65536) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // malformed JSON
          }
          // Schema validation — reject anything that doesn't match expected shape
          const valid = validateEvent(event);
          if (!valid) continue;
          if (type && valid.type !== type) continue;
          if (agentId && valid.agentId !== agentId) continue;
          if (since && valid.ts < since) continue;
          events.push(valid);
        }
      } catch {
        // File doesn't exist, skip
      }
    }
  } catch (error) {
    console.error('[Events] Failed to read events:', error.message);
  }

  return events.slice(-limit);
}

/**
 * Clean up old event files
 */
export async function cleanupOldEvents() {
  try {
    const files = await fs.readdir(EVENTS_DIR);
    const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);

    for (const file of files) {
      if (!file.startsWith('events-') || !file.endsWith('.jsonl')) continue;

      const dateStr = file.replace('events-', '').replace('.jsonl', '');
      const fileDate = new Date(dateStr).getTime();

      if (fileDate < cutoff) {
        await fs.unlink(path.join(EVENTS_DIR, file));
        console.log(`[Events] Cleaned up old events file: ${file}`);
      }
    }
  } catch (error) {
    console.error('[Events] Failed to cleanup:', error.message);
  }
}

// Legacy event type constants (kept for backward compat with existing callers)
export const EventType = {
  WAKE_REQUEST: 'wake_request',
  WAKE_COALESCED: 'wake_coalesced',
  WAKE_START: 'wake_start',
  WAKE_COMPLETE: 'wake_complete',
  WAKE_SILENT: 'wake_silent',
  WAKE_ERROR: 'wake_error',
  TASK_CREATED: 'task_created',
  TASK_START: 'task_start',
  TASK_COMPLETE: 'task_complete',
  TASK_FAILED: 'task_failed',
  TASK_BLOCKED: 'task_blocked',
  MODEL_CALL: 'model_call',
  MODEL_SUCCESS: 'model_success',
  MODEL_FALLBACK: 'model_fallback',
  MODEL_ERROR: 'model_error',
  COOLDOWN_SET: 'cooldown_set',
  COOLDOWN_CLEAR: 'cooldown_clear',
  PROFILE_BROKEN: 'profile_broken',
  LANE_ENQUEUE: 'lane_enqueue',
  LANE_START: 'lane_start',
  LANE_COMPLETE: 'lane_complete',
  STARTUP: 'startup',
  SHUTDOWN: 'shutdown',
  HEALTH_CHECK: 'health_check',
  ERROR: 'error',
};

// Legacy convenience wrappers (kept for backward compat)
export const log = {
  wakeStart: (agentId, reason) =>
    logEvent(EventType.WAKE_START, { agentId, reason }),

  wakeComplete: (agentId, result) =>
    logEvent(EventType.WAKE_COMPLETE, { agentId, result: result?.substring?.(0, 100) }),

  wakeSilent: (agentId) =>
    logEvent(EventType.WAKE_SILENT, { agentId }),

  wakeError: (agentId, error) =>
    logEvent(EventType.WAKE_ERROR, { agentId, error: error?.message || error }),

  taskCreated: (agentId, taskId, description) =>
    logEvent(EventType.TASK_CREATED, { agentId, taskId, description }),

  taskComplete: (agentId, taskId) =>
    logEvent(EventType.TASK_COMPLETE, { agentId, taskId }),

  modelFallback: (from, to, reason) =>
    logEvent(EventType.MODEL_FALLBACK, { from, to, reason }),

  error: (context, error) =>
    logEvent(EventType.ERROR, { context, error: error?.message || error, stack: error?.stack }),
};

export default {
  logEvent,
  readEvents,
  cleanupOldEvents,
  EventType,
  log,
};
