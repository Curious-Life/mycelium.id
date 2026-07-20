/**
 * Portal character router — the owner-facing window onto the agent's personality
 * capsule (mind/self.md) and its history (design §5.2 / §5.6). This is the "BEING"
 * text field of the character page, plus the V12 guardrail: authorship, a diff of
 * what changed, and revert.
 *
 *   GET  /character/being            → { content, tokens, tokenCap, author, changedAt, snapshots[] }
 *   PUT  /character/being  {content} → operator edit (snapshots prior state, records 'operator')
 *   GET  /character/being/diff?date= → lineDiff(dated snapshot → current)
 *   POST /character/being/revert {date} → restore a snapshot (snapshots current first, records 'operator')
 *
 * SECURITY (this is a security-sensitive surface — it writes the agent's identity):
 *  - Owner-only: every handler is behind authenticatePortalRequest (makePortalOwnerGate).
 *  - Writes go through mind-files.writeMindFile → the fail-closed sanitize gate
 *    (injection / credential / oversize) BEFORE encrypt; a blocked write returns a
 *    content-free 422 code, never a partial persist.
 *  - Provenance is entry-point-derived: every write here records author 'operator'
 *    (hardcoded). The agent cannot reach this router (owner gate) and cannot forge
 *    'operator' through its own tool path (that path hardcodes 'agent'). §5.2a's
 *    AGENT_NATURE floor is untouched — this only edits the layered self.md.
 *  - Snapshot reads are date-validated (no traversal); the content the owner reads
 *    is their own self.md over the gated channel and is never logged.
 */
import express from 'express';
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { createMindFiles } from './mindfiles/mind-files.js';
import { createAuthorship, contentHash } from './mindfiles/authorship.js';
import { captureSnapshot } from './mindfiles/snapshot.js';
import { lineDiff, diffStat } from './mindfiles/diff.js';
import { estimateTokens } from './inference/token-budget.js';
import { createVoiceRenderer } from './tts/voice-render.js';
import { createVoiceSampleStore, MAX_SAMPLE_BYTES } from './tts/voice-sample-store.js';
import { mindAgentRoot } from './paths.js';

const BEING_FILE = 'self.md';
// Mirrors context.js:29 CORE_TOKEN_CAP — the honest budget the integration cycle
// keeps self.md under ("≤~1000 tok; never bloat context"). Surfaced so the field
// can show the operator how close they are, not enforced here (the cycle trims).
const CHARACTER_TOKEN_CAP = 1200;
// A generous ceiling well above the token cap; the sanitize gate's MAX_TOKENS is
// the real bound. Guards against a giant PUT before it reaches the write path.
const MAX_BEING_BYTES = 64 * 1024;
// Same validity contract as listSnapshots' filter — shape AND range, no traversal.
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function portalCharacterRouter({
  userId = 'local-user',
  agentId = 'personal-agent',
  agentRoot,
  authenticatePortalRequest,
  db,
  fs = fsp,
  path = nodePath,
  fetch,
} = {}) {
  if (typeof authenticatePortalRequest !== 'function') {
    throw new Error('portalCharacterRouter: authenticatePortalRequest required');
  }
  const MAX_DESC = 500;
  // The voice DESCRIPTION is the "character sheet" (design §3): the plain-English
  // prose the operator wrote about how the voice should sound. It is re-rollable
  // and NOT the identity (the frozen sample is) — so it lives in the small
  // settings.agent.voice blob, independent of the sample, and persists even before
  // one is captured. Read-modify-write the whole blob (never wipe siblings, F8).
  const readVoiceDescription = async () => {
    try { return (await db?.users?.getSettings?.(userId))?.agent?.voice?.description || null; }
    catch { return null; }
  };
  const writeVoiceDescription = async (description) => {
    if (!db?.users?.getSettings) throw new Error('no-settings-store');
    try { await db.users.create?.(userId, userId); } catch { /* row exists */ }
    const s = (await db.users.getSettings(userId)) || {};
    const agent = { ...(s.agent || {}) };
    agent.voice = { ...(agent.voice || {}), description: description || null };
    await db.users.updateSettings(userId, { ...s, agent });
  };
  // Resolve the SAME agent root the agent cycle writes to, via the single-source
  // mindAgentRoot() so REST, MCP and backup/restore agree on one self.md.
  // NOTE: nothing sets MYCELIUM_AGENT_ROOT today (an earlier comment claimed the
  // packaged app does — it does NOT; grep confirms), so this resolves cwd-relative
  // to <cwd>/data/mind. That durability fragility is tracked separately — see the
  // ⚠️ DURABILITY note on mindAgentRoot() in src/paths.js.
  const resolvedRoot = agentRoot || mindAgentRoot();
  const mind = createMindFiles({ agentRoot: resolvedRoot, agentId, fs, path });
  const authorship = createAuthorship({ readMindFile: mind.readMindFile, writeMindFile: mind.writeMindFile });
  const snapDeps = { readMindFile: mind.readMindFile, writeMindFile: mind.writeMindFile };
  // Vault-side audition renderer (design §2.3). Owner-only; loopback-only; the
  // sample store defaults to the same dataDir hasVoiceSample() reads.
  const sampleStore = createVoiceSampleStore({});
  const voiceRenderer = createVoiceRenderer({ store: sampleStore, ...(fetch ? { fetch } : {}) });
  // Coarse in-memory rate limit for the render endpoint (render is ~1.25× realtime
  // — cheap to abuse). 5 renders / 60s, per process. Mirrors the settings preview.
  const previewHits = [];
  const rateLimited = () => {
    const now = Date.now(); const windowStart = now - 60_000;
    while (previewHits.length && previewHits[0] < windowStart) previewHits.shift();
    if (previewHits.length >= 5) return true;
    previewHits.push(now); return false;
  };

  const router = express.Router();
  // Per-route body parsers: text routes stay tight (256kb); ONLY the sample
  // upload gets the large limit (a base64 WAV up to ~11MB for an 8MB sample cap).
  const jsonSmall = express.json({ limit: '256kb' });
  const jsonLarge = express.json({ limit: '12mb' });
  const auth = (req, res) => {
    const u = authenticatePortalRequest(req);
    if (!u) { res.status(401).json({ ok: false, error: 'Unauthorized' }); return null; }
    return u;
  };
  // A blocked write surfaces a content-free code (§1) → 422; anything else is 500.
  const writeError = (res, e, verb) => {
    const msg = String(e?.message || '');
    if (msg.startsWith('mindfile-blocked:')) return res.status(422).json({ ok: false, error: msg });
    console.error(`[character] ${verb} failed: ${e?.name || 'Error'}`);
    return res.status(500).json({ ok: false, error: `${verb} failed` });
  };

  // Distinguish "self.md absent" from "self.md present but failed to decrypt":
  // readMindFile returns null for BOTH. If the file exists on disk yet reads null,
  // decryption failed — the operator must NOT be shown an empty capsule they might
  // overwrite (adversarial-review Lens B). getMindDir + access tells them apart.
  const beingFileExists = async () => {
    const dir = mind.getMindDir();
    if (!dir) return false;
    try { await fs.access(path.join(dir, BEING_FILE)); return true; } catch { return false; }
  };

  // GET /character/being — the capsule + provenance + history.
  router.get('/character/being', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const raw = await mind.readMindFile(BEING_FILE);
      const undecryptable = raw == null && (await beingFileExists());
      const content = raw || '';
      const author = await authorship.getAuthorship(BEING_FILE);
      // Staleness: the recorded attribution carries a hash of the content it was
      // recorded for. If the live content differs, the provenance write lagged the
      // content write (Finding 2) — say so rather than assert a possibly-wrong
      // author. Undecryptable content is stale by definition (can't be confirmed).
      const stale = undecryptable || !!(author?.hash && author.hash !== contentHash(content));
      res.json({
        ok: true,
        content,
        undecryptable,
        tokens: estimateTokens(content),
        tokenCap: CHARACTER_TOKEN_CAP,
        author: author?.author || null,
        changedAt: author?.at || null,
        stale,
        snapshots: await mind.listSnapshots(BEING_FILE),
      });
    } catch (e) {
      console.error(`[character] being read failed: ${e?.name || 'Error'}`);
      res.status(500).json({ ok: false, error: 'read failed' });
    }
  });

  // PUT /character/being — the operator rewrites who the agent is.
  router.put('/character/being', jsonSmall, async (req, res) => {
    if (!auth(req, res)) return;
    const content = typeof req.body?.content === 'string' ? req.body.content : null;
    if (content == null) return res.status(400).json({ ok: false, error: 'content required' });
    if (Buffer.byteLength(content, 'utf8') > MAX_BEING_BYTES) {
      return res.status(413).json({ ok: false, error: 'content too large' });
    }
    try {
      // Snapshot the PRIOR state first (first-write-wins per day) so this edit
      // joins the trail and is revertable. Best-effort — never blocks the write.
      try { await captureSnapshot(snapDeps, BEING_FILE); } catch { /* non-fatal */ }
      await mind.writeMindFile(BEING_FILE, content); // sanitize gate runs inside
      try { await authorship.recordWrite(BEING_FILE, 'operator', content); } catch { /* non-fatal */ }
      res.json({ ok: true, tokens: estimateTokens(content), tokenCap: CHARACTER_TOKEN_CAP });
    } catch (e) {
      writeError(res, e, 'write');
    }
  });

  // GET /character/being/diff?date=YYYY-MM-DD — what changed vs a dated snapshot.
  router.get('/character/being/diff', async (req, res) => {
    if (!auth(req, res)) return;
    const date = String(req.query.date || '');
    if (!DATE_RE.test(date)) return res.status(400).json({ ok: false, error: 'invalid date' });
    try {
      const snap = await mind.readMindFile(`snapshots/${BEING_FILE}/${date}.md`);
      if (snap == null) return res.status(404).json({ ok: false, error: 'snapshot not found' });
      const current = (await mind.readMindFile(BEING_FILE)) || '';
      const ops = lineDiff(snap, current);
      res.json({ ok: true, date, ops, stat: diffStat(ops) });
    } catch (e) {
      console.error(`[character] diff failed: ${e?.name || 'Error'}`);
      res.status(500).json({ ok: false, error: 'diff failed' });
    }
  });

  // POST /character/being/revert {date} — restore a snapshot. Revert is itself
  // undoable: the current state is snapshotted before the overwrite (§5.6).
  router.post('/character/being/revert', jsonSmall, async (req, res) => {
    if (!auth(req, res)) return;
    const date = String(req.body?.date || '');
    if (!DATE_RE.test(date)) return res.status(400).json({ ok: false, error: 'invalid date' });
    try {
      const snap = await mind.readMindFile(`snapshots/${BEING_FILE}/${date}.md`);
      if (snap == null) return res.status(404).json({ ok: false, error: 'snapshot not found' });
      try { await captureSnapshot(snapDeps, BEING_FILE); } catch { /* non-fatal */ }
      await mind.writeMindFile(BEING_FILE, snap); // sanitize gate runs inside
      try { await authorship.recordWrite(BEING_FILE, 'operator', snap); } catch { /* non-fatal */ }
      res.json({ ok: true, date, tokens: estimateTokens(snap), tokenCap: CHARACTER_TOKEN_CAP });
    } catch (e) {
      writeError(res, e, 'revert');
    }
  });

  // GET /character/voice — does a frozen sample exist, and its transcript.
  router.get('/character/voice', async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const sample = await sampleStore.getSample(agentId);
      res.json({
        ok: true,
        hasSample: !!sample,
        sampleText: sample?.sampleText || null,
        capturedAt: sample?.at || null,
        description: await readVoiceDescription(), // the character sheet (§3)
      });
    } catch (e) {
      console.error(`[character] voice read failed: ${e?.name || 'Error'}`);
      res.status(500).json({ ok: false, error: 'read failed' });
    }
  });

  // PUT /character/voice/description {description} — the voice "character sheet"
  // (design §3/§5). Prose the operator wrote about the voice; re-rollable, not the
  // identity. Owner-only. Persists independently of a frozen sample.
  router.put('/character/voice/description', jsonSmall, async (req, res) => {
    if (!auth(req, res)) return;
    const raw = req.body?.description;
    if (raw !== null && typeof raw !== 'string') return res.status(400).json({ ok: false, error: 'description must be a string or null' });
    const description = raw ? String(raw).slice(0, MAX_DESC) : null;
    try {
      await writeVoiceDescription(description);
      res.json({ ok: true, description });
    } catch (e) {
      if (String(e?.message) === 'no-settings-store') return res.status(501).json({ ok: false, error: 'settings store unavailable' });
      console.error(`[character] voice description save failed: ${e?.name || 'Error'}`);
      res.status(500).json({ ok: false, error: 'save failed' });
    }
  });

  // POST /character/voice/sample {wavB64, sampleText} — FREEZE a reference sample
  // (the "lock" of the ritual, design §5.1). Owner-only; the WAV rides base64 in a
  // dedicated body (NOT the small settings JSON). Stored encrypted at rest (V1u).
  router.post('/character/voice/sample', jsonLarge, async (req, res) => {
    if (!auth(req, res)) return;
    const wavB64 = typeof req.body?.wavB64 === 'string' ? req.body.wavB64 : null;
    const sampleText = typeof req.body?.sampleText === 'string' ? req.body.sampleText : '';
    if (!wavB64 || !sampleText.trim()) return res.status(400).json({ ok: false, error: 'wavB64 and sampleText required' });
    let wav;
    try { wav = Buffer.from(wavB64, 'base64'); } catch { return res.status(400).json({ ok: false, error: 'bad base64' }); }
    if (!wav.length) return res.status(400).json({ ok: false, error: 'empty sample' });
    if (wav.length > MAX_SAMPLE_BYTES) return res.status(413).json({ ok: false, error: 'sample too large' });
    try {
      await sampleStore.saveSample(agentId, { wav, sampleText: sampleText.trim() });
      res.json({ ok: true });
    } catch (e) {
      console.error(`[character] voice sample save failed: ${e?.name || 'Error'}`);
      res.status(500).json({ ok: false, error: 'save failed' });
    }
  });

  // DELETE /character/voice — clear the sample (re-roll / opt out).
  router.delete('/character/voice', async (req, res) => {
    if (!auth(req, res)) return;
    try { await sampleStore.deleteSample(agentId); res.json({ ok: true }); }
    catch (e) { console.error(`[character] voice delete failed: ${e?.name || 'Error'}`); res.status(500).json({ ok: false, error: 'delete failed' }); }
  });

  // POST /character/voice/preview {text?, instruct?} — the "▶ hear" audition.
  // Clones the agent's frozen sample to speak a line. Owner-only, rate-limited,
  // loopback-only. Honest states: 501 (no sample yet), 503 (MLX service down —
  // e.g. not Apple Silicon), 200 audio/wav. Real audio only verifies on an
  // Apple-Silicon box with the model + a sample (operator smoke).
  router.post('/character/voice/preview', jsonSmall, async (req, res) => {
    if (!auth(req, res)) return;
    if (rateLimited()) return res.status(429).json({ ok: false, error: 'rate-limited' });
    const text = String(req.body?.text || '').trim().slice(0, 500) || 'This is my voice.';
    // instruct is OWNER-supplied modulation (design §2.4). §7 Q3 (a bounded
    // vocabulary vs free-form) is OPEN — kept free-form + owner-only for now.
    const instruct = req.body?.instruct ? String(req.body.instruct).slice(0, 300) : undefined;
    const r = await voiceRenderer.renderWithSample({ agentId, text, instruct });
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('cache-control', 'no-store');
    res.send(r.audio);
  });

  return router;
}

export default portalCharacterRouter;
