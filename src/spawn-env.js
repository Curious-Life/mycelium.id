// src/spawn-env.js — identity env (USER/LOGNAME/HOME) for spawned children.
//
// THE PROBLEM: a Finder/Dock-launched macOS app runs under a launchd GUI session that does
// NOT export USER/LOGNAME (and sometimes not HOME). A child spawned with an explicit env
// ALLOWLIST built from `process.env.USER` then receives `USER: undefined`. Most pipeline
// children don't care, but some tooling filters on it (the `claude` CLI's macOS Keychain
// login lookup requires `account == $USER` — the 2026-07-08 subscription-auth bug), and a
// missing HOME breaks anything that resolves `~`.
//
// THE FIX: fill any missing USER/LOGNAME/HOME from os.userInfo() (getpwuid on the effective
// uid), which is correct regardless of how the app was launched. Fail-soft: if os.userInfo()
// throws (no matching passwd entry), fall back to whatever the inherited env had.

import os from 'node:os';

/**
 * Return {USER, LOGNAME, HOME} for a spawned child's env, preferring the inherited env and
 * filling any gaps from os.userInfo(). Only defined keys are returned, so callers can spread
 * the result into a childEnv allowlist without introducing `undefined` values. Never throws.
 * @param {NodeJS.ProcessEnv} [env=process.env] the parent env to read from
 * @returns {{USER?:string, LOGNAME?:string, HOME?:string}}
 */
export function identityEnv(env = process.env) {
  let info = null;
  try { info = os.userInfo(); } catch { /* no passwd entry → fall back to inherited env only */ }
  const user = env.USER || env.LOGNAME || info?.username || undefined;
  const home = env.HOME || info?.homedir || undefined;
  const out = {};
  if (user) { out.USER = user; out.LOGNAME = user; }
  if (home) out.HOME = home;
  return out;
}

export default identityEnv;
