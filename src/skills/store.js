// src/skills/store.js — editable reflection-engine skills (Context Engine L2, "own it").
//
// The persona ("how the agent shows up in your cycles") is an EDITABLE document at
// skills/persona/soul.md — seeded from the ported constant, then owned by the user: they edit
// it in the Library, and the agent edits it (updatePersona / updateDocument) when asked. The
// scheduler resolves it per cycle with a hard fallback to the constant, so a missing/empty/
// unreadable doc NEVER breaks a cycle. (Cycle BODIES are editable too, but they live in their
// scheduled_tasks.prompt — already encrypted, patchable, and what the scheduler runs — so the
// updateCycle tool edits them there; see src/tools/cycles.js.)
import { REFLECTION_PERSONA } from '../agent/cycle-prompts.js';
import { saveDocument as realSaveDocument } from '../core/document-store.js';

export const PERSONA_PATH = 'skills/persona/soul.md';

/**
 * The persona to inject for a reflection cycle: the user's edited doc if present, else the
 * ported default. Never throws — any read failure falls back to the constant.
 */
export async function resolvePersona(db, userId) {
  try {
    const row = await db?.documents?.get?.(userId, PERSONA_PATH);
    const content = row?.content;
    if (typeof content === 'string' && content.trim()) return content;
  } catch { /* fall through to the default */ }
  return REFLECTION_PERSONA;
}

/**
 * Seed the editable persona doc from the constant — only if absent (idempotent; never clobbers
 * a user's edits). saveDocument is injectable for tests.
 */
/**
 * The persona ONLY if the user (or agent) has CUSTOMIZED it — i.e. the doc exists and differs
 * from the seeded default. Live chat injects this so an edit to "how you show up" steers chat
 * AND cycles as one identity, while a default (unedited) install leaves chat behaviour exactly
 * as-is (no regression from dumping the heavy reflection voice into every chat turn). Null when
 * unset or still the default. Never throws.
 */
export async function resolveCustomPersona(db, userId) {
  try {
    const row = await db?.documents?.get?.(userId, PERSONA_PATH);
    const content = row?.content;
    if (typeof content !== 'string' || !content.trim()) return null;
    // "Custom" requires BOTH signals: the doc was EDITED after seeding (updated_at meaningfully
    // after created_at) AND its content differs from the current default. The edit-signal is the
    // load-bearing one — it makes this robust to a FUTURE change of the REFLECTION_PERSONA
    // constant: a seeded-but-untouched doc (updated_at≈created_at) is NEVER treated as custom,
    // so a constant edit can't silently flip chat behaviour for installs that never touched soul.md.
    const cAt = Date.parse(row.created_at || '');
    const uAt = Date.parse(row.updated_at || '');
    const editedAfterSeed = Number.isFinite(cAt) && Number.isFinite(uAt) && (uAt - cAt > 2000);
    const differsFromDefault = content.trim() !== REFLECTION_PERSONA.trim();
    if (editedAfterSeed && differsFromDefault) return content.trim();
  } catch { /* none → null */ }
  return null;
}

export async function seedPersonaDoc(db, userId, { saveDocument = realSaveDocument, logger = () => {} } = {}) {
  try {
    const existing = await db?.documents?.get?.(userId, PERSONA_PATH);
    if (existing) return { created: false };
    await saveDocument({ db }, {
      userId,
      source: 'agent-mcp',
      sourceType: 'skill',
      scope: 'personal',
      createdBy: 'reflection-engine',
      path: PERSONA_PATH,
      title: 'Reflection persona (editable)',
      content: REFLECTION_PERSONA,
    });
    logger('skills: seeded persona doc');
    return { created: true };
  } catch (e) {
    logger(`skills: persona seed skipped — ${e?.code || e?.name || 'error'}`);
    return { created: false };
  }
}
