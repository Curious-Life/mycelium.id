/**
 * Per-agent voice-sample store — the FROZEN reference sample that holds a voice's
 * identity (design §2.2/§2.3, the keystone finding). A described voice is not
 * reproducible; a cloned reference sample is. This persists that sample so
 * hasVoiceSample() can become true and the render path can clone from it
 * (ref_audio + ref_text).
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * A voice sample is biometric-ish — CLAUDE.md §7 treats embeddings/voiceprints
 * with plaintext-level paranoia. So the sample is ENCRYPTED at rest with the
 * crypto-local AES-256-GCM envelope (0600, atomic write). There is NO plaintext
 * WAV on disk. On-disk file (not D1) mirrors the mind-files precedent.
 *
 * ⚠️ ISOLATION IS PER-TENANT (cryptographic) + PER-AGENT (filename + payload-bound),
 * NOT per-agent-cryptographic (voice-panel audit, 2026-07-18). crypto-local.inferScope
 * collapses agent ids to at most three tenant scopes (moms/personal/wealth), so two
 * agents in the SAME tenant share one scope key — the ciphertext alone does not bind
 * to the agent. We therefore (a) separate agents by filename AND (b) bind the agentId
 * INSIDE the encrypted payload and verify it on read, so a swapped or case-collided
 * file is rejected rather than silently returning another agent's voiceprint. True
 * per-agent crypto derivation (a v2 per-agent-keyed envelope) is a follow-up if
 * multiple same-tenant agents ever hold distinct samples; cross-TENANT isolation is
 * already cryptographic here.
 *
 * On-disk format (mirrors mind-files.js): 4-byte magic "MVS1" + base64 envelope.
 *
 *   <dataDir>/voice-samples/<agentId>.mvs
 */
import { existsSync, statSync } from 'node:fs';
import { promises as fspDefault } from 'node:fs';
import nodePath from 'node:path';
import { encrypt, decrypt, getMasterKey, inferScope } from '../crypto/crypto-local.js';
import { dataDir } from '../paths.js';

const MAGIC = Buffer.from('MVS1', 'latin1'); // Mycelium Voice Sample, format v1
const SAVE_FILE_MODE = 0o600;
// A reference clip is short (a few seconds). 8 MB is generous headroom (48 kHz
// mono 16-bit ≈ 96 KB/s ⇒ ~80 s) and bounds a hostile/oversized upload.
export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
// On-disk cap: base64 (~1.34×) of the WAV + envelope overhead. Refuse to READ a
// file larger than this before allocating (a disk-access attacker could drop a
// multi-GB .mvs — voice-panel audit nit). 16 MB comfortably covers an 8 MB sample.
const MAX_FILE_BYTES = 16 * 1024 * 1024;

// agentId is app-internal ('personal-agent'), but treat it as untrusted for the
// filename: collapse anything outside a safe set so it can never traverse.
function safeAgentId(agentId) {
  const s = String(agentId || 'personal-agent').trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(s) ? s : null;
}

export function createVoiceSampleStore(opts = {}) {
  const fs = opts.fs || fspDefault;
  const path = opts.path || nodePath;
  const baseDir = opts.baseDir || path.join(dataDir(opts), 'voice-samples');
  // Scope PER AGENT so one agent's sample can never be decrypted under another's
  // scope — same routing mind files use (mind/<file> → personal|moms|…).
  const scopeFor = (agentId) => inferScope({ path: 'mind/voice-sample', agent_id: agentId });

  function fileFor(agentId) {
    const id = safeAgentId(agentId);
    if (!id) return null;
    return path.join(baseDir, `${id}.mvs`);
  }

  async function saveSample(agentId, { wav, sampleText } = {}) {
    const file = fileFor(agentId);
    if (!file) throw new Error('voice-sample: invalid agentId');
    if (!Buffer.isBuffer(wav) || wav.length === 0) throw new Error('voice-sample: wav Buffer required');
    if (wav.length > MAX_SAMPLE_BYTES) throw new Error('voice-sample: sample too large');
    if (typeof sampleText !== 'string' || !sampleText.trim()) throw new Error('voice-sample: sampleText required');

    // Bind the agentId INSIDE the ciphertext so a swapped/case-collided file is
    // rejected on read (the scope key alone doesn't bind the agent — see header).
    const id = safeAgentId(agentId);
    const payload = JSON.stringify({ v: 1, agentId: id, sampleText, wavB64: wav.toString('base64'), at: new Date().toISOString() });
    const masterKey = await getMasterKey();
    const envelope = await encrypt(payload, scopeFor(agentId), masterKey);
    const buf = Buffer.concat([MAGIC, Buffer.from(envelope, 'utf8')]);

    await fs.mkdir(baseDir, { recursive: true });
    const tmp = file + '.tmp';
    let fh;
    try {
      fh = await fs.open(tmp, 'w', SAVE_FILE_MODE);
      await fh.writeFile(buf);
      await fh.sync();
    } catch (err) {
      // Never leave an orphan tmp (voice-panel audit nit — it's ciphertext, but
      // hygiene). Best-effort unlink, then surface the real error.
      try { if (fh) await fh.close(); fh = null; await fs.rm(tmp, { force: true }); } catch { /* */ }
      throw err;
    } finally {
      if (fh) await fh.close();
    }
    await fs.rename(tmp, file);
    return { ok: true };
  }

  async function getSample(agentId) {
    const file = fileFor(agentId);
    if (!file) return null;
    // Refuse to read an oversized file before allocating (disk-attacker DoS nit).
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_FILE_BYTES) {
        console.warn(`[voice-sample] refusing oversized file for ${safeAgentId(agentId)} (${st.size}B)`);
        return null;
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    let raw;
    try {
      raw = await fs.readFile(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    // A file without the magic is not a valid sample — refuse rather than guess.
    if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const masterKey = await getMasterKey();
    let plain;
    try {
      plain = await decrypt(raw.subarray(MAGIC.length).toString('utf8'), masterKey, [scopeFor(agentId)]);
    } catch (err) {
      // Plaintext-free log (§1): agent id + error NAME only, never the payload.
      console.warn(`[voice-sample] decrypt failed for ${safeAgentId(agentId)}: ${err?.name || 'Error'}`);
      return null;
    }
    let o;
    try { o = JSON.parse(plain); } catch { return null; }
    if (!o || typeof o.wavB64 !== 'string' || typeof o.sampleText !== 'string') return null;
    // Payload agentId binding: reject a sample that was frozen for a DIFFERENT
    // agent (a swapped file, or a case-collision on a case-insensitive FS). The
    // scope key is shared within a tenant, so this — not the crypto — is what
    // stops one agent reading another's voiceprint. FAIL-CLOSED (§3): saveSample
    // ALWAYS stamps agentId, so an ABSENT binding is anomalous (a hand-planted or
    // pre-binding file) and is refused, not trusted — a present-but-mismatched OR a
    // missing binding both fail the same exact-match check.
    if (o.agentId !== safeAgentId(agentId)) {
      console.warn(`[voice-sample] agentId binding failed for ${safeAgentId(agentId)} — refusing`);
      return null;
    }
    return { sampleText: o.sampleText, wav: Buffer.from(o.wavB64, 'base64'), at: o.at || null };
  }

  async function deleteSample(agentId) {
    const file = fileFor(agentId);
    if (!file) return { ok: false };
    try { await fs.rm(file, { force: true }); } catch { /* best-effort */ }
    return { ok: true };
  }

  return { saveSample, getSample, deleteSample, baseDir, fileFor };
}

/**
 * SYNC existence check — TEST-ONLY. Production honesty now reads the async
 * decrypt-validating hasVoiceSample() (matches the render predicate); this cheap
 * file-presence probe ("exists" iff present and larger than the bare magic, never
 * an empty/truncated placeholder) is retained for gates that need a sync check.
 */
export function hasSampleSync(agentId, opts = {}) {
  const id = safeAgentId(agentId);
  if (!id) return false;
  const path = opts.path || nodePath;
  const baseDir = opts.baseDir || path.join(dataDir(opts), 'voice-samples');
  const file = path.join(baseDir, `${id}.mvs`);
  try { return existsSync(file) && statSync(file).size > MAGIC.length; } catch { return false; }
}
