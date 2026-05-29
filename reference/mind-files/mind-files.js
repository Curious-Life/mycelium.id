/**
 * Local mind-files helper — encryption-at-rest for per-agent disk state.
 *
 * Internal models, reflections, and flagged items live in per-agent
 * directories on disk (git-backed) rather than in D1. Keeps them fast
 * to read, compactable, and scoped to a single agent instance.
 *
 * Files are encrypted at rest using the same crypto-local AES-256-GCM
 * envelope as D1 ciphertext, R2 artifacts, and the mind-search index
 * snapshot. Format on disk:
 *
 *   bytes 0..3   magic "MIND"  (4 ASCII bytes, format v1)
 *   bytes 4..n   base64 envelope from crypto-local.encrypt()
 *
 * The 4-byte magic is purely a format marker — it lets us distinguish
 * "encrypted mind file" from "legacy plaintext .md" before attempting
 * decrypt. The envelope itself carries the cryptographic structure
 * (version, scope, IV, ciphertext, wrapped DEK).
 *
 * Backwards-compat (time-boxed): files without the "MIND" magic are
 * read as plaintext UTF-8. This survives partial migration during
 * rollout. A follow-up "PR-cleanup" will flip this to log-and-return-null
 * once all hosts are confirmed migrated. See
 * docs/MIND-FILES-ENCRYPTION-DESIGN-2026-05-08.md open question #6.
 *
 * Returns a family of small async helpers bound to a particular
 * AGENT_ROOT + agent identity. When AGENT_ROOT is unset, reads return
 * null and writes throw — callers that care about persistence should
 * check first.
 *
 * @typedef {object} MindFilesDeps
 * @property {string|null|undefined} agentRoot
 * @property {string} [agentId]  agent identity for scope inference; defaults to process.env.AGENT_ID
 * @property {typeof import('fs/promises')} fs
 * @property {typeof import('path')} path
 */

import { encrypt, decrypt, getMasterKey, inferScope } from './crypto-local.js';

const MAGIC = Buffer.from('MIND', 'latin1'); // 4 bytes, format v1
const SAVE_FILE_MODE = 0o600;

export function createMindFiles(deps) {
  if (!deps) throw new TypeError('createMindFiles: deps required');
  const { agentRoot, fs, path } = deps;
  if (!fs?.readFile || !fs?.writeFile || !fs?.mkdir || !fs?.rename || !fs?.open) {
    throw new TypeError('createMindFiles: fs.{readFile,writeFile,mkdir,rename,open} required');
  }
  if (!path?.join || !path?.dirname) {
    throw new TypeError('createMindFiles: path.{join,dirname} required');
  }

  // agentId resolves the scope ('personal' | 'moms' | 'org' | 'wealth')
  // via crypto-local's inferScope. mind/ paths route to 'personal' or
  // 'moms' (per crypto-local.js inferScope path branch).
  const _agentId = deps.agentId || process.env.AGENT_ID || 'personal-agent';

  function getMindDir() {
    if (!agentRoot) return null;
    return path.join(agentRoot, 'mind');
  }

  async function ensureMindDir() {
    const dir = getMindDir();
    if (dir) await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  function scopeForFile(filename) {
    return inferScope({ path: `mind/${filename}`, agent_id: _agentId });
  }

  async function readMindFile(filename) {
    const dir = getMindDir();
    if (!dir) return null;
    let raw;
    try {
      raw = await fs.readFile(path.join(dir, filename));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err; // EACCES, EIO, etc. — surface
    }

    // Backwards-compat: file without "MIND" magic → treat as plaintext.
    // Time-boxed during rollout; see open question #6 in the design.
    if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      return raw.toString('utf-8');
    }

    const envelope = raw.subarray(MAGIC.length).toString('utf8');
    const masterKey = await getMasterKey();
    const scope = scopeForFile(filename);
    try {
      return await decrypt(envelope, masterKey, [scope]);
    } catch (err) {
      // Plaintext-free log line per CLAUDE.md §1. Filename only, never body.
      console.warn(`[mind-files] decrypt failed for ${filename}: ${err && err.name ? err.name : 'Error'}`);
      return null;
    }
  }

  // Atomic encrypt-and-write: encrypt → magic-prefixed payload → tmp +
  // fsync + rename. POSIX rename is atomic same-filesystem, so a
  // concurrent reader sees either the previous content or the new —
  // never partial. Mirrors mind-search persist.js pattern.
  async function writeMindFile(filename, content) {
    const dir = await ensureMindDir();
    if (!dir) throw new Error('AGENT_ROOT not configured — cannot write mind files');
    const finalPath = path.join(dir, filename);
    const parentDir = path.dirname(finalPath);
    if (parentDir !== dir) {
      await fs.mkdir(parentDir, { recursive: true });
    }

    const masterKey = await getMasterKey();
    const scope = scopeForFile(filename);
    const envelope = await encrypt(String(content), scope, masterKey);
    const envelopeBuf = Buffer.from(envelope, 'utf8');
    const payload = Buffer.concat([MAGIC, envelopeBuf], MAGIC.length + envelopeBuf.length);

    const tmpPath = finalPath + '.tmp';
    let fh;
    try {
      fh = await fs.open(tmpPath, 'w', SAVE_FILE_MODE);
      await fh.writeFile(payload);
      await fh.sync();
    } finally {
      if (fh) await fh.close();
    }
    await fs.rename(tmpPath, finalPath);
  }

  return { getMindDir, ensureMindDir, readMindFile, writeMindFile };
}

/**
 * Canonical map of D1 document paths → local mind-file names.
 * updateDocument / editDocumentContent mirror writes to these files
 * so subsequent agent sessions can pre-load them as context without
 * a D1 round-trip. Other documents are NOT mirrored.
 */
export const MIND_MIRRORS = {
  'states/dreams':             'dreams.md',
  'internal/reflection_log':   'reflections.md',
  'internal/topology_notes':   'topology-notes.md',
  'phenomena/synchronicities': 'synchronicities.md',
};
