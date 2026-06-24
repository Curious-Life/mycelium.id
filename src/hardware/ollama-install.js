// src/hardware/ollama-install.js — download the official Ollama runtime into the
// app's data dir, verify it against a PINNED checksum, and extract it, so the
// local-model picker works without the user installing anything by hand.
//
// WHY the standalone tarball (not install.sh / the .dmg): the tarball runs with
// NO sudo, NO system service, NO PATH change — we extract into an app-private
// dir and run `ollama serve` ourselves. (install.sh requires root, makes a
// system user, and installs a systemd unit; the .dmg installs a GUI .app.)
// Ollama is MIT-licensed, so redistribution/relocation is permitted, and the
// macOS build is codesigned + notarized (no Gatekeeper prompt).
//
// SECURITY (CLAUDE.md §2/§3/§6 — this is the download+execute surface):
//   • PINNED version + PINNED per-asset SHA-256 (the CHECKSUMS map below, which
//     ships inside the signed .app — it is never fetched). A mismatch DELETES the
//     download and aborts; we NEVER extract or execute an unverified binary.
//   • Fixed download URL over HTTPS from the pinned GitHub release.
//   • Extraction via `tar` with fixed args (no shell); files land app-private.
//   • No secrets touched; logs carry only progress + outcome.
//
// To bump Ollama: change OLLAMA_VERSION + paste the new asset hashes from that
// release's sha256sum.txt. Keep the pin recent enough to run the catalog (newer
// models like gemma4 need a current Ollama).

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync as nodeExistsSync, createReadStream } from 'node:fs';
import { mkdir as nodeMkdir, rm as nodeRm, chmod as nodeChmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const execFileP = promisify(execFile);

// Pinned release — bump together with the catalog (see module header).
export const OLLAMA_VERSION = 'v0.30.5';

// Pinned SHA-256 per asset for OLLAMA_VERSION (from that release's sha256sum.txt).
// VERIFY when bumping: https://github.com/ollama/ollama/releases/download/<ver>/sha256sum.txt
const CHECKSUMS = Object.freeze({
  'ollama-darwin.tgz':            '1defa6bfac03cdc2c3e996a1b79b69eb4eb7d711b5aeb623001497b37a3de41b',
  'ollama-linux-amd64.tar.zst':   '36d104f9b9e318d0f742e2291f553ee40791b5f0a7b866e3a896eecd789568b6',
  'ollama-linux-arm64.tar.zst':   '12da8c15e4c397bacaf1a509456e4a8662b72ed97938d7d63affe10a34f9ca89',
  'ollama-windows-amd64.zip':     '1aaed66884e1a9317278a2bc5428f92155d016cb50a3acf37430630d0ab52623',
});

/**
 * Map a platform/arch to the pinned release asset + its verified URL + sha256.
 * @returns {{asset:string, url:string, sha256:string, kind:'tgz'|'zst'|'zip'}|null}
 */
export function resolveAsset({ platform = process.platform, arch = process.arch } = {}) {
  let asset = null, kind = null;
  if (platform === 'darwin') { asset = 'ollama-darwin.tgz'; kind = 'tgz'; }          // universal (arm64 + x64)
  else if (platform === 'linux' && arch === 'x64') { asset = 'ollama-linux-amd64.tar.zst'; kind = 'zst'; }
  else if (platform === 'linux' && arch === 'arm64') { asset = 'ollama-linux-arm64.tar.zst'; kind = 'zst'; }
  else if (platform === 'win32' && arch === 'x64') { asset = 'ollama-windows-amd64.zip'; kind = 'zip'; }
  if (!asset || !CHECKSUMS[asset]) return null;
  return { asset, kind, sha256: CHECKSUMS[asset], url: `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/${asset}` };
}

// ── default primitives (all injectable for tests) ────────────────────────────

async function defaultDownload(url, dest, onProgress, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download ${r.status}`);
  const total = Number(r.headers?.get?.('content-length')) || 0;
  let done = 0;
  const ws = createWriteStream(dest);
  // Count bytes for progress while streaming to disk.
  const reader = r.body.getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    if (!ws.write(Buffer.from(value))) await new Promise((res) => ws.once('drain', res));
    if (total && typeof onProgress === 'function') onProgress(Math.min(100, Math.round((done / total) * 100)), done, total);
  }
  await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
}

function defaultSha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// Extract with the system `tar` (no shell). `.tgz` is gzip (works everywhere);
// `.tar.zst` needs zstd present on the box — fail-soft if it isn't.
async function defaultExtract(archivePath, destDir, kind) {
  if (kind === 'tgz') return void (await execFileP('tar', ['-xzf', archivePath, '-C', destDir]));
  if (kind === 'zst') return void (await execFileP('tar', ['-xf', archivePath, '-C', destDir])); // tar auto-detects zstd
  throw new Error(`unsupported archive kind: ${kind}`); // zip handled elsewhere / deferred
}

const defaultFs = {
  mkdir: (p) => nodeMkdir(p, { recursive: true }),
  rm: (p) => nodeRm(p, { force: true }),
  chmod: (p) => nodeChmod(p, 0o755),
  existsSync: nodeExistsSync,
};

/** The `ollama` binary path after extraction (root or bin/). */
export function extractedBinPath(dataDir, existsSync = nodeExistsSync) {
  const root = join(dataDir, 'ollama');
  for (const c of [join(root, 'ollama'), join(root, 'bin', 'ollama')]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Download + verify + extract the Ollama runtime into <dataDir>/ollama.
 * Fully injectable. Fail-closed: a checksum mismatch deletes the file and aborts
 * BEFORE extraction — an unverified binary is never written into place or run.
 * @returns {Promise<{ok:boolean, binPath?:string, reason?:string}>}
 */
export async function installOllama({
  dataDir,
  platform = process.platform,
  arch = process.arch,
  download = defaultDownload,
  sha256 = defaultSha256,
  extract = defaultExtract,
  fs = defaultFs,
  fetch = globalThis.fetch,
  onProgress,
  log = () => {},
} = {}) {
  const sel = resolveAsset({ platform, arch });
  if (!sel) return { ok: false, reason: 'unsupported_platform' };
  if (sel.kind === 'zip') return { ok: false, reason: 'unsupported_platform' }; // Windows extract deferred

  const root = join(dataDir, 'ollama');
  const dlDir = join(root, '.dl');
  const archive = join(dlDir, sel.asset);
  try {
    await fs.mkdir(dlDir);
    log(`[ollama-install] downloading ${sel.asset} (${OLLAMA_VERSION})`);
    await download(sel.url, archive, onProgress, fetch);

    const got = await sha256(archive);
    if (got !== sel.sha256) {
      await fs.rm(archive);
      log('[ollama-install] checksum mismatch — aborting');
      return { ok: false, reason: 'checksum_mismatch' };
    }

    await extract(archive, root, sel.kind);
    await fs.rm(archive); // drop the archive; keep the extracted runtime
    const binPath = extractedBinPath(dataDir, fs.existsSync);
    if (!binPath) return { ok: false, reason: 'extract_failed' };
    await fs.chmod(binPath);
    log('[ollama-install] installed');
    return { ok: true, binPath };
  } catch (e) {
    try { await fs.rm(archive); } catch { /* noop */ }
    log(`[ollama-install] download failed: ${e?.message || e}`);
    return { ok: false, reason: 'download_failed' };
  }
}

export default installOllama;
