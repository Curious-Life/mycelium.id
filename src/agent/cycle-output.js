// src/agent/cycle-output.js — the single, well-tested decision point for what a
// reflection-cycle turn actually DELIVERS (or skips), and an idempotent delivery id.
//
// Why this exists: a cycle's check-in reaches the person as the turn's FINAL TEXT.
// Trusting the model to emit a bare `NO_REPLY` sentinel in free text is fragile — in
// production a capable model, on an empty day, wrote a diagnostic report ("System
// Status: NO_DATA_FOUND …") or wrapped the sentinel as `**NO_REPLY**`, both of which
// leaked to the person. This module makes the deliver/skip decision robust and pure,
// so it's unit-testable and identical everywhere.
//
// SECURITY: this can only ever SUPPRESS a delivery (fail-closed) — it never causes one.
// It reads only the model's own final text; it never logs content.

import { createHash } from 'node:crypto';

// NO_REPLY is a RESERVED sentinel that must never appear in a real check-in. So its
// presence ANYWHERE — bare, markdown-wrapped (`**NO_REPLY**`), quoted, or followed by
// commentary ("NO_REPLY. No data was found…") — means the model intended to skip.
// Tolerates NO_REPLY / NO-REPLY / NO REPLY, any case.
const SENTINEL_RE = /\bNO[\s_-]?REPLY\b/i;

/** True when the turn's text means "send nothing" (empty, or contains the reserved sentinel). */
export function isSkipSentinel(text) {
  const t = String(text ?? '');
  if (!t.trim()) return true;
  return SENTINEL_RE.test(t);
}

// A check-in must speak to the person, not narrate the agent's own plumbing. On thin
// days a model sometimes "reports" on its empty tools instead of skipping. These signals
// catch that class so it's suppressed rather than delivered. Conservative: a real warm
// message never leads with "System Status" nor name-drops two internal tools.
const LEADING_META_RE = /^[\s>*_~`"'#()\-.]*(system status|no[_ ]?data|status:|diagnosis:|error:|report:)/i;
// Only the UNAMBIGUOUS internal camelCase tool names — a warm check-in never name-drops these,
// but the plumbing-report class does. Deliberately NOT plain words like "mindscape"/"pipeline"
// (a person legitimately says "I looked at my mindscape") which would false-positive a real message.
const TOOL_NAME_RE = /\b(getDailyMessages|searchMindscape|readMindFile|getEntityContext|writeMindFileWhole|editMindFile|snapshotMindFile|updateInternalModel|flagForDiscussion|recordReflection|getContext|proposeClaim)\b/g;
const META_PHRASE_RE = /\b(no[_ ]?data[_ ]?found|data streams?|inaccessible|internal buffers?|as an ai\b|i (?:do not|don'?t) have access|empty results?|no (?:new )?flags?|missed patterns?)\b/gi;

/** True when the text reads like a self-referential status/plumbing report rather than a check-in. */
export function looksLikeMetaReport(text) {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (LEADING_META_RE.test(t)) return true;
  const tools = new Set(t.match(TOOL_NAME_RE) || []).size;
  const phrases = new Set((t.match(META_PHRASE_RE) || []).map((s) => s.toLowerCase())).size;
  return (tools + phrases) >= 2;
}

/**
 * Decide what a fired cycle turn does with its result. Pure.
 * @param {object} result  the turn result: { text?, truncated?, skipped? }
 * @param {object} task     the scheduled_tasks row (output_target)
 * @returns {{action:'deliver'|'skip', status:string, text?:string, reason?:string}}
 *   status is what gets recorded on the run + surfaced in the dashboard.
 */
export function finalizeCycleOutput(result, task) {
  const r = result || {};
  // Pre-turn skips (decided before/without composing) map straight to their status.
  if (r.skipped === 'no-model') return { action: 'skip', status: 'skipped-no-model' };
  if (r.skipped === 'model-incapable') return { action: 'skip', status: 'skipped-model-incapable' };
  if (r.skipped === 'quiet') return { action: 'skip', status: 'skipped-quiet' };
  // A truncated turn is a fragment — never deliver half a thought.
  if (r.truncated) return { action: 'skip', status: 'skipped-truncated' };

  const text = typeof r.text === 'string' ? r.text : '';
  const target = task?.output_target;

  // Internal cycles (target 'none') run to update memory and never deliver — a clean 'done'.
  if (!target || target === 'none') return { action: 'skip', status: 'done' };

  if (!text.trim()) return { action: 'skip', status: 'done-silent' };
  if (isSkipSentinel(text)) return { action: 'skip', status: 'done-silent', reason: 'sentinel' };
  if (looksLikeMetaReport(text)) return { action: 'skip', status: 'skipped-lowquality', reason: 'meta' };
  return { action: 'deliver', status: 'done', text };
}

/**
 * A stable id for the message a cycle delivers on a given scheduled fire, so an
 * overlapping tick / boot re-run of the SAME due instant can't post it twice
 * (captureMessage dedups on caller-supplied id). Distinct per task + fire instant.
 */
export function cycleDeliveryId(task) {
  return `cyc-${createHash('sha256').update(`${task?.id || ''}|${task?.next_run || ''}`).digest('hex').slice(0, 40)}`;
}

export default finalizeCycleOutput;
