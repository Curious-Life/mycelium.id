// src/ingest/detect-sources-child.js — the detection sweep, run as its own process (D-126).
//
// WHY A CHILD AND NOT THE EVENT LOOP. `detectSources()` is a synchronous recursive
// `readdirSync` walk, and one iCloud-evicted (dataless) directory made that walk block
// inside the `__getdirentries64` syscall indefinitely — live-reproduced 2026-07-30:
// 2543/2543 main-thread samples wedged there, every portal endpoint head-of-line-blocked,
// the whole app reading as "Load failed". A blocked SYNC syscall cannot be interrupted
// from JS; only process isolation makes the scan killable. So the route spawns THIS
// script (the snapshot-worker.mjs pattern) and enforces a wall-clock deadline on the
// parent side — a wedged scan now costs one orphaned child, never the server.
//
// PRIVACY: identical posture to detectSources() — allowlisted roots, presence/counts/
// dates only, never file contents. Output is one JSON line on stdout, content-free.
// macOS TCC attributes a child's file access to the responsible app process, so the
// grant/prompt behaviour is unchanged from the in-process walk.
import { detectSources, probeSweepAccess } from './detect-sources.js';

let sources = [];
let blocked = [];
try { sources = detectSources(); } catch { /* a detector throwing never breaks the scan */ }
try { blocked = probeSweepAccess(); } catch { /* */ }
process.stdout.write(JSON.stringify({ ok: true, sources, blocked }));
