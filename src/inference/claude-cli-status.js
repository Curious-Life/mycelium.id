// src/inference/claude-cli-status.js — is the Claude Code CLI installed, which
// version, and is that version new enough to run as the agent engine?
//
// WHY THIS EXISTS (QA6 · recoverability P1). The Engine card offered "Claude Code"
// and, when it wasn't usable, rendered a DISABLED button. A disabled button eats the
// click: no handler fires, `title` tooltips don't show on disabled controls in several
// browsers, and the only explanation was a 0.62rem grey tag most users never read. The
// operator's report — "clicking Claude Code does nothing, it stays unselectable with no
// reason given" — is exactly that. The cure is not a bigger tooltip: it is KNOWING the
// three facts a user needs to act (installed? which version? is it current?) and saying
// them out loud with the command that fixes it.
//
// DISCIPLINE MIRRORED FROM THE OLLAMA VERSION GATE (src/hardware/ollama-daemon.js:
// OLLAMA_MIN_VERSION + versionGte + a /api/version probe): a version check with an
// honest, actionable message, and a deliberate answer for "can't tell".
//
//   installed=false           → terminal, ACTIONABLE ("install it: <command>")
//   installed, version too old→ terminal, ACTIONABLE ("update: <command>")
//   installed, version unknown→ NOT terminal. An unparseable `--version` must never
//                               re-create the dead click, so `versionOk` is null and
//                               the caller treats null as usable (fail-OPEN on the
//                               VERSION only — never on installation, never on consent).
//
// WHY A MINIMUM AT ALL (security, not tidiness). The cli engine's confinement rests on
// `--strict-mcp-config` + `--tools "mcp__mycelium__*"` (src/agent/loop-claude-cli.js:124).
// The live spike that PROVED confinement ran claude 2.1.198; `--allowedTools` alone was
// shown NOT to confine. A 1.x CLI is not proven to honour `--tools`, so spawning one
// would be an unproven-confinement regression. Too-old therefore fails CLOSED for
// selection — but with a next step, never a silent no-op.
//
// SECURITY (§1/§8): this module returns booleans + a dotted version string ONLY. It
// never returns or logs the resolved binary path — that path embeds the user's home
// directory (`/Users/<name>/.local/bin/claude`), i.e. a user identifier, and this value
// is serialized to the portal. `probeClaudeCli` also never touches credentials.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveClaudeBin } from './claude-bin.js';

const execFileP = promisify(execFile);

/**
 * Minimum `claude` version the cli engine will run.
 * See the confinement rationale above before lowering this.
 */
export const CLAUDE_MIN_VERSION = '2.0.0';

/** The commands we tell the user to run. Kept here so UI + gate read ONE source. */
export const CLAUDE_INSTALL_COMMAND = 'npm i -g @anthropic-ai/claude-code';
export const CLAUDE_UPDATE_COMMAND = 'claude update';
export const CLAUDE_DOCS_URL = 'https://docs.claude.com/en/docs/claude-code/setup';

// The npm dist-tag endpoint for the published CLI. GET only, no query string, no
// headers, no user data — a package name is not an identifier of this user (§privacy:
// never put personal data in a URL). Best-effort by contract: see fetchLatestClaudeVersion.
const NPM_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;   // 6h — a version number does not move fast
const LATEST_TIMEOUT_MS = 2000;

/** Parse "2.1.198" / "v2.1.198" / "2.1.198 (Claude Code)" → [maj,min,patch], or null. */
export function parseClaudeVersion(s) {
  const m = String(s ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Semver-triple ≥ comparison. Accepts triples or version STRINGS. An UNPARSEABLE
 * input → false, and callers must decide what that means (here: "can't tell", which
 * probeClaudeCli reports as versionOk:null rather than a blocking false).
 */
export function claudeVersionGte(a, b) {
  const pa = Array.isArray(a) ? a : parseClaudeVersion(a);
  const pb = Array.isArray(b) ? b : parseClaudeVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) { if (pa[i] > pb[i]) return true; if (pa[i] < pb[i]) return false; }
  return true;
}

/** Format a triple back to a dotted string ('2.1.198'), or null. */
function fmt(triple) { return Array.isArray(triple) ? triple.join('.') : null; }

/** Best-effort `<bin> --version` → dotted string, or null. Never throws. */
async function defaultBinaryVersion(bin) {
  try {
    const { stdout, stderr } = await execFileP(bin, ['--version'], { timeout: 4000 });
    return fmt(parseClaudeVersion(`${stdout || ''} ${stderr || ''}`));
  } catch (e) {
    // A non-zero exit can still have printed the version (the ollama probe hit exactly
    // this). Salvage the output before giving up.
    const salvaged = parseClaudeVersion(`${e?.stdout || ''} ${e?.stderr || ''}`);
    return fmt(salvaged);
  }
}

// Module-scope cache for the network lookup. Deliberately in-memory: it is a public
// version number, worth nothing persisted, and a process restart re-checking is fine.
let latestCache = { at: 0, value: null };

/**
 * Best-effort "what is the latest published version". NEVER blocks and NEVER throws:
 * offline, blocked, slow or malformed all resolve to null, and every caller treats
 * null as "unknown" — the UI must degrade to "installed, v2.1.198", never to a wall.
 *
 * Opt-out: MYCELIUM_NO_UPDATE_CHECK=1 disables the request entirely (an air-gapped
 * vault makes zero outbound calls from this path).
 */
export async function fetchLatestClaudeVersion({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  cache = true,
} = {}) {
  if (env.MYCELIUM_NO_UPDATE_CHECK === '1') return null;
  const t = now();
  if (cache && latestCache.value && (t - latestCache.at) < LATEST_TTL_MS) return latestCache.value;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(LATEST_TIMEOUT_MS) : undefined;
    const r = await fetchImpl(NPM_LATEST_URL, { signal });
    if (!r?.ok) return null;
    const data = await r.json();
    const v = fmt(parseClaudeVersion(data?.version));
    if (v && cache) latestCache = { at: t, value: v };
    return v;
  } catch { return null; }   // offline / DNS / timeout / malformed → unknown, not an error
}

/** Test seam: drop the memoized "latest" so a gate can exercise a cold lookup. */
export function _resetLatestCache() { latestCache = { at: 0, value: null }; }

/**
 * The three facts, plus the next step. Never throws.
 *
 * @returns {Promise<{
 *   installed: boolean,
 *   version: string|null,
 *   versionOk: boolean|null,       // null = installed but version unreadable → usable
 *   minVersion: string,
 *   latestVersion: string|null,    // null = unknown (offline / opted out) — NOT an error
 *   updateAvailable: boolean,      // strictly informational; never gates selection
 *   usable: boolean,               // installed && versionOk !== false
 *   reason: 'ok'|'not_installed'|'outdated',
 *   action: { message: string, command: string|null, docsUrl: string },
 * }>}
 */
export async function probeClaudeCli({
  findBin = resolveClaudeBin,
  binaryVersion = defaultBinaryVersion,
  latest = fetchLatestClaudeVersion,
  minVersion = CLAUDE_MIN_VERSION,
  env = process.env,
  platform = process.platform,
} = {}) {
  let bin = null;
  try { bin = findBin({ env, platform }); } catch { bin = null; }
  // The "latest" lookup runs for EVERY branch and is awaited only alongside the local
  // probe — it can add information ("v1.2 found; latest is v2.1.198") but it can never
  // be the thing that decides usability. Offline ⇒ null ⇒ the copy simply omits it.
  const latestP = Promise.resolve().then(() => latest({ env })).catch(() => null);

  if (!bin) {
    const latestVersion = await latestP;
    return {
      installed: false,
      version: null,
      versionOk: null,
      minVersion,
      latestVersion,
      updateAvailable: false,
      usable: false,
      reason: 'not_installed',
      action: {
        message: `Claude Code isn't installed on this machine${latestVersion ? ` (latest is v${latestVersion})` : ''}. Install it, then re-check.`,
        command: CLAUDE_INSTALL_COMMAND,
        docsUrl: CLAUDE_DOCS_URL,
      },
    };
  }

  let version = null;
  try { version = await binaryVersion(bin); } catch { version = null; }
  const latestVersion = await latestP;
  // versionOk is TRI-STATE on purpose. `false` only when the version PARSED and is
  // provably below the floor; an unreadable version is `null` (usable) so a future
  // `--version` format change can never resurrect the dead click.
  const versionOk = version == null ? null : claudeVersionGte(version, minVersion);
  const updateAvailable = Boolean(version && latestVersion && !claudeVersionGte(version, latestVersion));

  if (versionOk === false) {
    return {
      installed: true,
      version,
      versionOk,
      minVersion,
      latestVersion,
      updateAvailable,
      usable: false,
      reason: 'outdated',
      action: {
        message: `Claude Code v${version} is installed, but v${minVersion} or newer is required${latestVersion ? ` (latest is v${latestVersion})` : ''}. Update it, then re-check.`,
        command: CLAUDE_UPDATE_COMMAND,
        docsUrl: CLAUDE_DOCS_URL,
      },
    };
  }

  return {
    installed: true,
    version,
    versionOk,
    minVersion,
    latestVersion,
    updateAvailable,
    usable: true,
    reason: 'ok',
    action: {
      message: updateAvailable
        ? `Claude Code v${version} is installed and usable; v${latestVersion} is available.`
        : version
          ? `Claude Code v${version} is installed.`
          : 'Claude Code is installed.',
      command: updateAvailable ? CLAUDE_UPDATE_COMMAND : null,
      docsUrl: CLAUDE_DOCS_URL,
    },
  };
}

export default probeClaudeCli;
