// src/hardware/detect.js — detect the box's RAM / CPU / GPU for the S6 recommender.
//
// Dependency-light + fail-soft: every probe is wrapped, and any failure degrades
// to a safe default (no GPU, RAM-only) rather than throwing. GPU probes use
// execFile (NEVER a shell) so a model/device name can never become a command.
//
// Probe strategy borrowed from odysseus services/hwfit/hardware.py (MIT):
//   • RAM/CPU  → node:os
//   • NVIDIA   → `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits`
//   • AMD      → /sys/class/drm/card*/device/mem_info_vram_total
//   • Apple    → unified memory: budget a fraction of system RAM
//
// All fields are non-secret hardware facts; they are shown only in the authed
// portal and never logged alongside vault data.

import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';

const execFileP = promisify(execFile);
const GB = 1024 ** 3;
const round1 = (n) => Math.round(n * 10) / 10;

// Apple Silicon unified-memory budget ladder (odysseus): the usable share of
// total RAM for model weights scales up as the machine gets bigger.
function appleUnifiedFrac(totalGb) {
  if (totalGb <= 16) return 0.67;
  if (totalGb <= 64) return 0.75;
  return 0.8;
}

/**
 * Detect hardware. All collaborators are injectable for tests.
 * @param {object} [deps]
 * @param {object} [deps.osMod]    node:os (injectable)
 * @param {Function} [deps.runCmd] (cmd, args) => Promise<stdout string>
 * @param {Function} [deps.readSys] (path) => string
 * @param {Function} [deps.listDrm] () => string[] (entries of /sys/class/drm)
 * @returns {Promise<object>}
 */
export async function detectHardware({
  osMod = os,
  runCmd = async (cmd, args) => (await execFileP(cmd, args, { timeout: 4000 })).stdout,
  readSys = (p) => readFileSync(p, 'utf8'),
  listDrm = () => readdirSync('/sys/class/drm'),
} = {}) {
  const totalRamGb = round1(osMod.totalmem() / GB);
  const availableRamGb = round1(osMod.freemem() / GB);
  const cpus = osMod.cpus() || [];
  const arch = osMod.arch();
  const platform = osMod.platform();
  const base = {
    totalRamGb, availableRamGb,
    cpuCores: cpus.length,
    cpuName: (cpus[0]?.model || 'unknown').trim(),
    arch, platform,
    hasGpu: false, gpuName: null, gpuVramGb: 0, gpuCount: 0,
    unifiedMemory: false, backend: 'cpu',
  };

  // Apple Silicon → unified memory (no discrete VRAM; budget a slice of RAM).
  if (platform === 'darwin' && arch === 'arm64') {
    return {
      ...base, hasGpu: true, unifiedMemory: true, backend: 'metal',
      gpuName: 'Apple Silicon (unified memory)', gpuCount: 1,
      gpuVramGb: round1(totalRamGb * appleUnifiedFrac(totalRamGb)),
    };
  }

  // NVIDIA via nvidia-smi (execFile — no shell). Fail-soft on ENOENT/timeout.
  try {
    const out = await runCmd('nvidia-smi', ['--query-gpu=memory.total,name', '--format=csv,noheader,nounits']);
    const lines = String(out).trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) {
      const [mibStr, ...nameParts] = lines[0].split(',');
      const mib = Number(String(mibStr).trim());
      if (Number.isFinite(mib) && mib > 0) {
        return {
          ...base, hasGpu: true, backend: 'cuda',
          gpuName: (nameParts.join(',').trim() || 'NVIDIA GPU'),
          gpuCount: lines.length, gpuVramGb: round1(mib / 1024),
        };
      }
    }
  } catch { /* no NVIDIA — fall through */ }

  // AMD via sysfs (Linux). Use the first card reporting VRAM. Fail-soft.
  try {
    const cards = listDrm().filter((d) => /^card\d+$/.test(d));
    for (const c of cards) {
      try {
        const bytes = Number(String(readSys(`/sys/class/drm/${c}/device/mem_info_vram_total`)).trim());
        if (Number.isFinite(bytes) && bytes > 0) {
          return {
            ...base, hasGpu: true, backend: 'rocm',
            gpuName: 'AMD GPU', gpuCount: 1, gpuVramGb: round1(bytes / GB),
          };
        }
      } catch { /* this card has no vram file — try the next */ }
    }
  } catch { /* no sysfs — fall through */ }

  return base; // CPU-only
}

export default detectHardware;
