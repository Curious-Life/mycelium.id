// scripts/ensure-portal-built.mjs — make a fresh source checkout "just work".
//
// Wired as the `prestart`/`preportal` npm hook, so `npm start` (or `npm run
// portal`) auto-builds the canonical SvelteKit UI (portal-app) the FIRST time,
// installing portal-app's deps if needed. Idempotent + fast: once the build
// exists it's a silent no-op. This is why a fresh clone no longer serves the
// "not built" placeholder — the real UI is built before the server starts.
//
// The packaged desktop app does NOT run this (build-app-bundle.sh builds the UI
// at bundle time, and main.rs launches node directly, not via npm) — this is
// purely the dev/source convenience.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const PORTAL_APP = path.join(REPO, 'portal-app');
const BUILT = path.join(PORTAL_APP, 'build', '200.html');
const DEPS = path.join(PORTAL_APP, 'node_modules');

// Escape hatch: skip the auto-build (e.g. CI that builds the portal itself, or a
// deliberate placeholder run).
if (process.env.MYCELIUM_SKIP_PORTAL_BUILD === '1') process.exit(0);

if (existsSync(BUILT)) process.exit(0); // already built — nothing to do

const run = (args) => execFileSync('npm', args, { cwd: REPO, stdio: 'inherit' });
try {
  if (!existsSync(DEPS)) {
    console.error('[mycelium] first run: installing the portal UI dependencies (one-time)…');
    // ci when a lockfile is present (reproducible), else install.
    run(['--prefix', 'portal-app', existsSync(path.join(PORTAL_APP, 'package-lock.json')) ? 'ci' : 'install']);
  }
  console.error('[mycelium] first run: building the portal UI (portal-app → build)…');
  run(['--prefix', 'portal-app', 'run', 'build']);
  console.error('[mycelium] portal UI built — starting the server.');
} catch (e) {
  // Don't hard-fail the server start: fall back to the placeholder (which tells
  // the user to run `npm run portal:build`), but make the reason loud.
  console.error(`[mycelium] WARNING — could not auto-build the portal UI (${e.message}). ` +
    'The server will serve the "not built" placeholder; fix the build then re-run, ' +
    'or build manually: npm run portal:build');
}
