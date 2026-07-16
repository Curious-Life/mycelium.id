// src/system/platform-env.js — cross-platform env/path primitives.
//
// A single home for the handful of POSIX assumptions that were scattered across
// the subprocess-spawning modules (embed/transcribe/tts supervisors, binary
// discovery): splitting PATH on ':', reading HOME, and finding an executable on
// disk. On Windows PATH is ';'-delimited, the home dir is USERPROFILE (not HOME),
// and a bare command has no implicit extension — PATHEXT decides (the Claude CLI
// is `claude.cmd` there, never claude.exe). These are PURE functions (platform +
// env injectable) so the verify gate exercises win32 AND posix on any host.
//
// Design note: tiny and dependency-free by intent. They compute strings/paths —
// they never spawn, log, or read secrets, and they touch no `os` state (see
// homeDir for why that matters). Child-process identity (USER/LOGNAME/HOME) is
// NOT this module's job: that is src/spawn-env.js#identityEnv().
import path from 'node:path';
import { existsSync, accessSync, constants as fsConstants } from 'node:fs';

/** Split a PATH string into entries using the platform's delimiter (';' win, ':' posix). */
export function splitPath(pathValue, { platform = process.platform } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  return String(pathValue || '').split(sep).filter(Boolean);
}

/**
 * The home directory FROM THE GIVEN ENV, per-OS: USERPROFILE (win) / HOME (posix).
 * Returns '' when the env carries none.
 *
 * Deliberately does NOT fall back to os.homedir(): (a) os.homedir() THROWS when
 * HOME is unset and there is no passwd entry (distroless / `docker run -u 1001`),
 * and callers like resolveHarness() invoke discovery bare — a throw there would
 * 500 a chat turn where the old `if (env.HOME)` simply skipped the candidate;
 * (b) an os fallback would escape an INJECTED env, so a caller probing with a
 * scrubbed env would silently hit the real host's home. Env-only keeps this pure,
 * hermetic and non-throwing. (Child-process identity is spawn-env.js#identityEnv.)
 */
export function homeDir({ env = process.env, platform = process.platform } = {}) {
  const v = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return (typeof v === 'string' && v.trim()) ? v : '';
}

/**
 * Executable name candidates for a BARE command, in probe order. On win32 a bare
 * name has no implicit extension: PATHEXT decides. This matters — the Claude CLI
 * is npm-installed on Windows as `claude.cmd` (there is no claude.exe), so an
 * .exe-only probe would never find it. Honors PATHEXT when present.
 */
export function exeNames(base, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return [base];
  if (/\.[a-z0-9]+$/i.test(base)) return [base];            // caller was explicit
  // Honor PATHEXT's ORDER, but INTERSECT it with a fixed safe set. A real PATHEXT
  // also carries .VBS/.JS/.WSF/.MSC — expanding over those would let a `claude.js`
  // sitting on PATH be resolved and spawned, quietly widening the fixed candidate
  // allowlist these callers depend on (CLAUDE.md §4). Native/shim executables only.
  const SAFE = new Set(['.com', '.exe', '.cmd', '.bat']);
  const exts = String(env.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';').map((e) => e.trim().toLowerCase()).filter((e) => SAFE.has(e));
  return (exts.length ? exts : ['.exe', '.cmd', '.bat']).map((e) => `${base}${e}`);
}

/** Append the platform executable suffix (.exe on win32) if not already present. */
export function exeName(base, { platform = process.platform } = {}) {
  if (platform !== 'win32') return base;
  return /\.[a-z0-9]+$/i.test(base) ? base : `${base}.exe`;
}

// NOTE: child-env identity (USER/LOGNAME/HOME) is NOT this module's job — that is
// src/spawn-env.js#identityEnv(), already wired into the jobs.js childEnv allowlists.
// When Windows child-env support is needed, EXTEND identityEnv with USERPROFILE/
// USERNAME fallbacks rather than adding a second convention here.

/**
 * Resolve an executable: return the first candidate that exists + is executable,
 * checking (1) the absolute candidates as given, then (2) each PATH dir joined
 * with each bare candidate's basename (with the platform exe suffix). Returns the
 * resolved absolute path, or null if none found. Injectable for tests.
 *
 * A candidate is EITHER an absolute path (probed verbatim) OR a bare command name
 * (probed against each PATH dir, expanded over PATHEXT on win32). A relative path
 * with directories is REJECTED, not silently reduced to its basename — collapsing
 * `./vendor/claude` into a PATH search for `claude` would quietly widen the fixed
 * candidate allowlist the callers rely on (CLAUDE.md §4).
 *
 * @param {string[]} candidates  absolute paths and/or bare names to probe
 * @param {object}   opts
 * @param {object}   [opts.env]        default process.env (reads PATH, PATHEXT)
 * @param {string}   [opts.platform]   default process.platform
 * @param {(p:string)=>boolean} [opts.isExecutable]  injectable probe
 */
export function findExecutable(candidates, {
  env = process.env,
  platform = process.platform,
  isExecutable,
} = {}) {
  // Use the TARGET platform's path semantics (separator, drive-letter absolutes),
  // not the host's — so a win32 candidate resolves correctly even when this code
  // runs on posix (and the verify gate can exercise both branches on one host).
  const P = platform === 'win32' ? path.win32 : path.posix;
  // Bind the probe to the TARGET platform too, else the default would branch on
  // the host and be wrong under injection.
  const probe = isExecutable || ((p) => defaultIsExecutable(p, platform));
  const names = [];
  const absolutes = [];
  for (const c of candidates || []) {
    if (!c) continue;
    if (P.isAbsolute(c)) absolutes.push(exeName(c, { platform }));
    else if (P.basename(c) === c) names.push(c);   // bare name only
    // else: relative-with-directories → ignored (see contract above)
  }
  // 1) absolute candidates first (homebrew, /Applications, %ProgramFiles%, …)
  for (const abs of absolutes) if (probe(abs)) return abs;
  // 2) each PATH dir × each bare name × each platform extension
  for (const dir of splitPath(env.PATH, { platform })) {
    for (const name of names) {
      for (const withExt of exeNames(name, { platform, env })) {
        const full = P.join(dir, withExt);
        if (probe(full)) return full;
      }
    }
  }
  return null;
}

/**
 * The venv interpreter path for `<home>/pipeline/.venv`, per-OS:
 *   posix → pipeline/.venv/bin/python3
 *   win32 → pipeline\.venv\Scripts\python.exe
 */
export function venvPythonPath(home, { platform = process.platform } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32'
    ? P.join(home, 'pipeline', '.venv', 'Scripts', 'python.exe')
    : P.join(home, 'pipeline', '.venv', 'bin', 'python3');
}

/** The bundled-runtime interpreter path (`<home>/python`), per-OS. */
export function bundledPythonPath(home, { platform = process.platform } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32'
    ? P.join(home, 'python', 'python.exe')
    : P.join(home, 'python', 'bin', 'python3');
}

/**
 * The bare system-Python command to fall back to on PATH.
 *
 * `python3` on EVERY platform — deliberately identical to the pre-existing literal,
 * so this is a no-op refactor with zero regression surface. It is tempting to return
 * `python` on win32, but a bare `python`/`python3` there usually resolves to the
 * Microsoft Store App Execution Alias stub, which spawns fine and does nothing
 * (exit 9009) — a silent failure worse than not finding it. Windows resolves via
 * venvPythonPath()/MYCELIUM_PYTHON, which is the real path anyway; picking a correct
 * bare Windows fallback (`py -3`) needs a launcher+args change and a Windows smoke,
 * so it is deferred rather than guessed at.
 */
export function systemPython() { return 'python3'; }

function defaultIsExecutable(p, platform = process.platform) {
  try {
    if (!existsSync(p)) return false;
    // On Windows there is no X-bit; existence of the executable is sufficient. On
    // posix require the execute permission so we don't return a non-runnable match.
    if (platform === 'win32') return true;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch { return false; }
}
