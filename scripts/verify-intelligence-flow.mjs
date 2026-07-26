// verify:intelligence-flow — the Intelligence pane as a FLOW (Part I of
// the Intelligence-screen redesign), MOUNTED and driven for real.
//
// Covers the client half of the acceptance criteria: A5 (STATE A/B polarity), A2's render
// (the stated total), A3 (no second assignment surface — the REAL demoted AISettings is
// mounted), A8 (every fault has a control; choices are never red), A9 (one persistent live
// region, textContent-swapped), A10 (the pane is a flow, not a pile), W2/W3 (connect chip +
// voice later-unlock), W4 (disk refusal), W5 (no pre-consent checkmarks), W6 (the scoped
// gap-fill). The server half (A1/A7/W4-server) is verify:intelligence-bundle.
//
// Everything asserted here comes from portal-app/test/mount-intelligence-flow.mjs — real
// compiler, real DOM, real clicks; the bundle fixture is produced by the REAL composeBundle.
//
// MUTATION-TESTED: restoring the deleted `CLAUDE_SUB_MODELS` roster in AISettings.svelte and
//   merging the served list after it (the pre-D-074 shape) → F25 RED (the picker offered
//   claude-opus-4-8 / claude-sonnet-5 / claude-fable-5 / claude-haiku-4-5, none of which the
//   provider returned).
// MUTATION-TESTED: making `subModelsNote` always null — i.e. rendering a fallback list with no
//   qualifier → F25b RED.
// MUTATION-TESTED: dropping the `?refresh=1` from the Refresh button (so it re-reads the
//   server's TTL cache) → F25c RED.
// MUTATION-TESTED: removing the claude-sonnet-5 / claude-fable-5 rows from MODEL_REGISTRY (the
//   state this fix shipped in before review) → F25d RED — the offline floor offers less than the
//   roster it replaced.
// MUTATION-TESTED: relabelling the empty option back to "Default for your plan" → F25e RED.
// MUTATION-TESTED: dropping the "for chat" scope from that label (naming the chat default as if
//   it governed every job) → F25e RED.
// All five restored; the suite returns GREEN on the restored tree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
// The REAL fallback derivation (F25d asserts on the product, not on a fixture mirror of it).
import { fallbackModelsFor } from '../src/inference/model-catalog.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

function drive(harness, probe) {
  return JSON.parse(
    execFileSync('node', ['--conditions', 'browser', harness],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, ...(probe ? { PROBE: probe } : {}) } })
      .trim().split('\n').pop(),
  );
}

let cold = {}, returning = {}, fault = {}, disklow = {}, readfail = {}, ai = {}, voiceSample = {};
let subSplit = {}, subOk = {}, subUnknown = {};
try { cold = drive('test/mount-intelligence-flow.mjs'); } catch (e) { cold = { error: String(e?.message || e) }; }
try { returning = drive('test/mount-intelligence-flow.mjs', 'returning'); } catch (e) { returning = { error: String(e?.message || e) }; }
try { voiceSample = drive('test/mount-intelligence-flow.mjs', 'voice-sample'); } catch (e) { voiceSample = { error: String(e?.message || e) }; }
let embedderAbsent = {}, embedderDown = {}, voiceError = {}, voiceRuntime = {};
try { embedderAbsent = drive('test/mount-intelligence-flow.mjs', 'embedder-absent'); } catch (e) { embedderAbsent = { error: String(e?.message || e) }; }
try { embedderDown = drive('test/mount-intelligence-flow.mjs', 'embedder-down'); } catch (e) { embedderDown = { error: String(e?.message || e) }; }
let runtimeDown; try { runtimeDown = drive('test/mount-intelligence-flow.mjs', 'runtime-down'); } catch (e) { runtimeDown = { error: String(e?.message || e) }; }
let ollamaStrand; try { ollamaStrand = drive('test/mount-intelligence-flow.mjs', 'ollama-strand'); } catch (e) { ollamaStrand = { error: String(e?.message || e) }; }
try { voiceError = drive('test/mount-intelligence-flow.mjs', 'voice-error'); } catch (e) { voiceError = { error: String(e?.message || e) }; }
try { voiceRuntime = drive('test/mount-intelligence-flow.mjs', 'voice-needs-runtime'); } catch (e) { voiceRuntime = { error: String(e?.message || e) }; }
try { fault = drive('test/mount-intelligence-flow.mjs', 'fault'); } catch (e) { fault = { error: String(e?.message || e) }; }
try { disklow = drive('test/mount-intelligence-flow.mjs', 'disklow'); } catch (e) { disklow = { error: String(e?.message || e) }; }
try { readfail = drive('test/mount-intelligence-flow.mjs', 'readfail'); } catch (e) { readfail = { error: String(e?.message || e) }; }
try { ai = drive('test/mount-ai-settings.mjs'); } catch (e) { ai = { error: String(e?.message || e) }; }
// D-074 — the subscription model picker, mounted with a subscription connected. Two probes: the
// provider answered (sub), and it could not be listed so the server served the dated floor
// (sub-stale). The default `ai` probe has no subscription, so the picker is absent there (F11).
let aiSub = {}, aiSubStale = {};
try { aiSub = drive('test/mount-ai-settings.mjs', 'sub'); } catch (e) { aiSub = { error: String(e?.message || e) }; }
try { aiSubStale = drive('test/mount-ai-settings.mjs', 'sub-stale'); } catch (e) { aiSubStale = { error: String(e?.message || e) }; }
// The auth-VALIDITY probes ("connected must mean VALID", 2026-07-18) — see the harness header.
try { subSplit = drive('test/mount-intelligence-flow.mjs', 'sub-split'); } catch (e) { subSplit = { error: String(e?.message || e) }; }
try { subOk = drive('test/mount-intelligence-flow.mjs', 'sub-ok'); } catch (e) { subOk = { error: String(e?.message || e) }; }
try { subUnknown = drive('test/mount-intelligence-flow.mjs', 'sub-unknown'); } catch (e) { subUnknown = { error: String(e?.message || e) }; }

rec('F0. the flow mounts in every probe', cold.ok === true && returning.ok === true && fault.ok === true && disklow.ok === true,
  [cold, returning, fault, disklow].map((x) => x.error || '').filter(Boolean).join(' | ').slice(0, 300));
rec('F0b. the demoted AISettings mounts', ai.ok === true, ai.error ? String(ai.error).slice(0, 200) : '');

t('F1. ⭐ A5 — STATE A iff cold, STATE B iff configured; the two NEVER render together', () => {
  assert.equal(cold.before.state, 'A', 'no on-box approval + no provider ⇒ the first-run card');
  assert.deepEqual(cold.before.statesRendered, ['A'], 'exactly one state section — never both');
  assert.equal(returning.before.state, 'B', 'any assignment/connection ⇒ the summary');
  assert.deepEqual(returning.before.statesRendered, ['B']);
});

t('F2. ⭐ the one-tap walk: confirm → apply → BOTH download routes → the pane flips to B by FACT', () => {
  const s = cold.afterConfirm.sent;
  assert.ok(s.some((x) => x.path === '/portal/intelligence/bundle/apply'), `the confirm must POST the orchestrator. Sent: ${JSON.stringify(s)}`);
  assert.ok(s.some((x) => x.path === '/portal/hardware/pull' && x.body?.name === 'qwen3.5:4b'),
    'the labeling download starts through the EXISTING SSE route (installs Ollama first) — the tap must deliver the bytes it promised');
  assert.ok(s.some((x) => x.path === '/portal/transcription/download' && x.body?.model),
    'whisper starts through ITS OWN route (which persists the choice — the one writer)');
  assert.equal(cold.afterConfirm.state, 'B', 'after apply the pane is STATE B — driven by the re-read facts, not a session flag');
  assert.deepEqual(cold.afterConfirm.statesRendered, ['B'], 'and A is GONE (§3.7a polarity)');
});

t('F3. W1/W5 — human-first rows, NO pre-consent checkmarks, ids demoted to secondary type', () => {
  assert.match(cold.before.rowsText, /Understand my messages/, 'outcome language leads');
  assert.match(cold.before.rowsText, /on this Mac/, '"where it runs" is the decided fact');
  assert.match(cold.before.rowsText, /qwen3\.5:4b/, 'the model id is real (demoted, not hidden)');
  assert.equal(cold.before.cardHasCheckmark, false,
    'a ✓ before the user agreed reads as already-done (W5) — rows are plain until applied');
});

t('F4. A2 (render) — the button STATES the total; the free-disk line states headroom (W4)', () => {
  assert.match(String(cold.before.confirmLabel), /Set everything up · 5 GB/,
    `the stated total must be the composed sum (3.4 qwen + 1.6 whisper on a 16 GB box). Got: ${cold.before.confirmLabel}`);
  assert.equal(cold.before.freeDiskLine, '48', 'W4: "You have N GB free" renders from the served disk fact');
});

t('F5. W2/W3 — Conversation is a CONNECT CHIP, Voice a muted later-unlock; neither is a bundle row', () => {
  assert.equal(cold.before.hasConnectChip, true, 'the chip must exist: an OAuth hop no tap can do');
  assert.equal(cold.before.hasVoiceLater, true, 'the voice line keeps the capability discoverable');
  assert.equal(cold.before.voiceIsBundleRow, false,
    'W3: bundling 2.9 GB whose render answers 501 voice-sample-pending breaks the executability rule');
  assert.ok(!/Set everything up · 7\.9|2\.9 GB/.test(cold.before.text), 'and the total must not include the voice bytes');
});

t('F6. W4 — a can\'t-fit bundle disables the confirm and says how much to free', () => {
  assert.equal(disklow.before.confirmDisabled, true, 'no dead tap over a refusal the server would issue');
  assert.equal(disklow.before.diskWarn, '4', `the copy must carry the number. Text: ${disklow.before.text?.slice(0, 200)}`);
});

t('F7. ⭐ A9 — ONE persistent live region; announcements swap its TEXT, never re-insert it', () => {
  assert.equal(cold.before.liveRegionCount, 1, 'exactly one aria-live region, mounted from the start');
  assert.equal(cold.before.liveText, '', 'it mounts EMPTY — an element inserted already-containing-text is announced inconsistently (#204 r3)');
  assert.equal(cold.afterConfirm.liveSameElement, true, 'after the confirm it is the SAME element (identity, not equality)');
  assert.equal(cold.afterConfirm.liveRegionCount, 1);
  assert.ok(cold.afterConfirm.liveText && cold.afterConfirm.liveText.length > 0, 'and it now carries the announcement');
  assert.equal(cold.customize.liveSameElement, true, 'opening Customize does not remount it either');
});

t('F8. ⭐ A10 — Customize is a TWO-tab nav (Functions · Providers); Voice + Engine fold INTO Functions', () => {
  // The redesign (2026-07-19): Customize was three heavyweight sections stacked open at once
  // (assignment · connect-manage · engine — the wall the operator called "hell"). It is now a
  // segmented nav of TWO tabs:
  //   • Functions  — the ONE assignment surface: every job, INCLUDING Voice (its own row, #240's
  //                  fold) and Engine (the Conversation row's "runs as" control). IntelligenceScreen
  //                  owns all three, so a stale Voice/Engine tab can never drift from assignment.
  //   • Providers  — connect & manage (AISettings).
  // The guarantees that MUST survive:
  //   1. the machinery is still HIDDEN behind the closed disclosure (a door, not the pane);
  //   2. exactly two tabs, in order — Functions then Providers (nothing deleted);
  //   3. the default is Functions, mounting the REAL screen WITH Voice + Engine folded in;
  //   4. it is a nav, NOT a wall: Providers is behind its own tab, one panel at a time.
  for (const probe of [cold, returning]) {
    assert.equal(probe.before.aiSettingsMounted, false, 'AISettings must sit behind the CLOSED disclosure');
    assert.equal(probe.before.engineMounted, false, 'EngineSelector too — not mounted until Functions opens');
    assert.equal(probe.before.assignmentMounted, false, 'and the assignment screen');
    assert.deepEqual(probe.customize.navTabs, ['Functions', 'Providers'],
      'two tabs now: Functions · Providers (Voice + Engine folded into Functions, not their own sections)');
    assert.equal(probe.customize.screenRendered, true, 'the default tab is Functions, with the REAL IntelligenceScreen (.intel)');
    assert.equal(probe.customize.defaultTab.voice, true, 'Voice folded IN — its rail renders inside the Functions surface (#240 tts row), not a separate section');
    assert.equal(probe.customize.defaultTab.engine, true, 'Engine folded IN — the Conversation row hosts it, not a separate section');
    assert.equal(probe.customize.defaultTab.aiSettings, false, 'but NOT Providers — one panel at a time, the wall is gone');
    assert.equal(probe.customize.providersTab.aiSettings, true, 'the Providers tab reveals AISettings (the #133 ladder is reachable)');
    assert.equal(probe.customize.providersTab.assignment, false, 'and switching to it UNMOUNTS the Functions panel — a nav, not a wall');
  }
});

t('F9. ⭐ W6 — the gap-fill: ≥2 recommended functions unset ⇒ one scoped tap, sized to what is missing', () => {
  assert.match(String(returning.before.gapButton), /Finish setting up · 1\.6 GB/,
    `transcription (1.6) + descriptions (0) missing ⇒ 1.6 GB. Got: ${returning.before.gapButton}`);
  const applyCall = returning.gapClick.sent.find((x) => x.path === '/portal/intelligence/bundle/apply');
  assert.ok(applyCall, 'the tap must call the SAME orchestrator');
  assert.deepEqual(applyCall.body, { functions: ['transcription', 'descriptions'] },
    'SCOPED to the missing rows only — fill the gaps, never touch what the user has (PRESERVE symmetry)');
});

// ── F16–F18) the unified On-device models panel — the operator's "one place" (2026-07-18) ─────
// One place showing every local model with honest health + size + a single download action,
// consolidating what was scattered across OnboxTaskSelect / TranscriptionSetup / VoiceSection —
// and finally MOUNTING the purpose-built ModelHealth renderer (an orphan until now). Asserted on
// the genuine article: real OnDeviceModels + real ModelHealth compiled and clicked in the harness.
t('F16. the panel renders ALL FOUR local models, once, in one place', () => {
  assert.equal(returning.before.odmPresent, true, 'the On-device models section must render in the returning summary');
  const keys = (returning.before.odmRows || []).map((r) => r.key);
  assert.deepEqual([...keys].sort(), ['search', 'transcription', 'understanding', 'voice'],
    `all four local models, exactly once each — got ${JSON.stringify(keys)}`);
  const byKey = Object.fromEntries((returning.before.odmRows || []).map((r) => [r.key, r]));
  // Nomic (Search) is BUNDLED — reported "Included", green, never a download button (§3.10d-c).
  assert.match(String(byKey.search?.statusText), /Included/i, 'the bundled embedder reads "Included"');
  assert.equal(byKey.search?.hasDownload, false, 'and offers no download — it ships in the app');
  assert.equal(byKey.search?.okDot, true, 'a reported-healthy bundled model gets the green dot');
  // qwen3.5 is installed+approved in this fixture ⇒ its honest health, no download offered.
  assert.equal(byKey.understanding?.okDot, true, 'the approved+installed labeler reads ok');
  assert.equal(byKey.understanding?.hasDownload, false, 'no re-download over an installed model');
});

t('F17. the panel is the ONE download entry point — whisper + voice offer a download when absent, routed to their OWN paths', () => {
  const byKey = Object.fromEntries((returning.before.odmRows || []).map((r) => [r.key, r]));
  // Whisper is not installed in this fixture ⇒ a Download with its real size (composed, not hardcoded).
  assert.equal(byKey.transcription?.hasDownload, true, 'an un-downloaded whisper must offer a one-tap download');
  assert.match(String(byKey.transcription?.size), /1\.6 GB/, `and state its size from the served bundle — got ${byKey.transcription?.size}`);
  // Voice is individually downloadable from the panel (the "available to download meanwhile" case).
  assert.equal(byKey.voice?.hasDownload, true, 'voice is downloadable from the one place, even before it can speak');
  // …and the click routes to the model's OWN path — never a new/forked download path.
  const sent = returning.odmDownload?.sent || [];
  assert.ok(sent.some((s) => s.path === '/portal/settings/tts/qwen/download' && s.method === 'POST'),
    `the voice Download must POST the existing tts route. Sent: ${JSON.stringify(sent)}`);
});

t('F18. ⭐ a downloaded-but-mute voice reads as an actionable WARNING, never a false "ready" (W2 executability)', () => {
  // The gated-on-runnable decision: the Qwen3-TTS MODEL can be present while it still cannot
  // speak (no reference sample yet, §2.2/§5). The panel must say so — a warning with the next
  // step — and must NOT paint it green or offer a pointless re-download.
  const v = (voiceSample.before?.odmRows || []).find((r) => r.key === 'voice');
  assert.ok(v, `the voice row must render in the voice-sample probe — got ${JSON.stringify(voiceSample.before?.odmRows)}`);
  assert.equal(v.okDot, false, 'a voice that cannot speak must NOT show the green health dot');
  assert.equal(v.warnDot, true, 'it is an actionable setup step — a warning, not a fault, not a false ok');
  assert.match(String(v.statusText), /voice sample/i, `and it must name the next step — got "${v.statusText}"`);
  assert.equal(v.hasDownload, false, 'the model is already downloaded — no dead re-download button');
  // R2-VOICEBTN: the "add a voice sample" step must be a CLICKABLE button, not a dead note. It
  // must render AND route to the character page (where the record/upload capture lives) — the
  // bug was that the message named the step but shipped no button (action evaluated to 'none').
  assert.equal(v.hasAddSample, true, 'the downloaded-but-mute voice must offer a clickable "add a voice sample" button (R2-VOICEBTN)');
  assert.match(String(v.addSampleText), /voice sample/i, `the button must name the step — got "${v.addSampleText}"`);
  const sample = voiceSample.odmSample;
  assert.ok(sample?.hadButton, 'the add-sample button must be present for the click-drive');
  assert.equal(sample.routes.length, 1, `clicking it must route exactly once — got ${JSON.stringify(sample.routes)}`);
  assert.equal(sample.routes[0].viewId, 'character', 'it must route to the character view');
  assert.equal(sample.routes[0].params?.id, 'personal-agent', 'to the personal-agent character (where voice capture lives)');
  // ⚠️ Phase 3 removed the panel↔summary disagreement class at the ROOT: local models render ONLY
  // in the panel now, so there is no summary voice dot to contradict it. F21 pins that the summary
  // carries NO local rows (the de-dup), which is a stronger guarantee than the two agreeing.
});

t('F18b. ⭐ a NEEDS-RUNTIME voice offers "Finish install" (the tts route), NEVER the character page (R2-VOICEBTN review)', () => {
  // voiceHealth() collapses TWO blockers into status 'deps_missing': ready+sample-pending AND
  // needs-runtime (mlx-audio not installed). They are NOT the same fix — a reference sample cannot
  // install a runtime. So needs-runtime must NOT get the 'add a voice sample' route (a dead end:
  // CharacterView has no runtime-install path); it must offer "Finish install" → the tts download
  // route (the same one VoiceSection's Finish-install button uses). This is the regression the
  // review caught: keying the action on the collapsed status sent needs-runtime to the wrong place.
  assert.equal(voiceRuntime.ok, true, String(voiceRuntime.error || '').slice(0, 200));
  const v = (voiceRuntime.before?.odmRows || []).find((r) => r.key === 'voice');
  assert.ok(v, `the voice row must render in the needs-runtime probe — got ${JSON.stringify(voiceRuntime.before?.odmRows)}`);
  assert.equal(v.hasAddSample, false, 'needs-runtime must NOT offer the "add a voice sample" button (recording a sample cannot install the runtime)');
  assert.equal(v.hasDownload, true, 'needs-runtime must offer a button to finish the install');
  assert.match(String(v.downloadText), /finish install/i, `and it must read "Finish install" — got "${v.downloadText}"`);
  const rt = voiceRuntime.odmRuntime;
  assert.ok(rt?.hadDownload && !rt.hadAddSample, `only the Finish-install button, no add-sample — got ${JSON.stringify(rt)}`);
  assert.equal(rt.routes.length, 0, `it must NOT route to the character page — got ${JSON.stringify(rt.routes)}`);
  assert.ok(rt.sent.some((s) => /\/portal\/settings\/tts\/qwen\/download/.test(s.path)),
    `it must POST the tts download/install route. Sent: ${JSON.stringify(rt.sent)}`);
});

t('F19. ⭐ an ABSENT embedder is idle, never a fabricated green "Included" (review finding F2)', () => {
  // `models.embedder` is undefined until the readiness poll resolves — and forever on an outage.
  // The panel used to inject a synthetic {status:'ok'} for that window, painting the green dot
  // ModelHealth's own fail-closed 'included' fix removed. Absence must read as idle, never health.
  assert.equal(embedderAbsent.ok, true, String(embedderAbsent.error || '').slice(0, 200));
  const s = (embedderAbsent.before?.odmRows || []).find((r) => r.key === 'search');
  assert.ok(s, `the search row must render even with no embedder health — got ${JSON.stringify(embedderAbsent.before?.odmRows)}`);
  assert.equal(s.okDot, false, 'an embedder that has reported NOTHING must not paint the green "Included" dot — that is fabricated liveness');
  assert.match(String(s.statusText), /Included/i, 'the one fact that never changes still renders — it IS bundled — just not as a health claim');
  // (Phase 3: the embedder no longer has a summary row to fabricate a green on — it lives only in
  // the panel, asserted above. F21 pins that the summary carries no local rows.)
});

t('F20. a FAILED voice download reads red AND offers a retry (F3 dead-branch, now gated)', () => {
  // voiceHealth() maps phase 'error' → status 'down' (not 'error'), so the panel action guard had
  // to gate on 'down' or the retry Download never rendered on a failed download (review F3). Drive
  // the failed state and prove the retry is live and the dot is a genuine red fault.
  assert.equal(voiceError.ok, true, String(voiceError.error || '').slice(0, 200));
  const ve = (voiceError.before?.odmRows || []).find((r) => r.key === 'voice');
  assert.ok(ve, `the voice row must render in the voice-error probe — got ${JSON.stringify(voiceError.before?.odmRows)}`);
  assert.equal(ve.badDot, true, 'a failed voice download reads red (a genuine fault), not muted or green');
  assert.equal(ve.hasDownload, true, 'and offers a retry — a failed download IS re-fetchable, unlike an installed model');
});

t('F22. ⭐ a FAILED embedder (bundled Nomic download failed) reads red AND offers a Retry that pokes /portal/embed/retry — never a fake "Included" ✓ (the fresh-install hang)', () => {
  // The P0: the embedder is NOT infallibly "bundled + ok" — its ONNX weights download from
  // HuggingFace at first load, and that can fail. When it does, the Search row must show the TRUE
  // state (red) and a Retry wired to the ONE resume path (POST /portal/embed/retry → nudge the
  // supervisor + drainer to re-attempt the download), NOT a green "Included" that strands the user
  // at "Processing 0/N" with nothing embedding and no escape.
  assert.equal(embedderDown.ok, true, String(embedderDown.error || '').slice(0, 200));
  const s = (embedderDown.before?.odmRows || []).find((r) => r.key === 'search');
  assert.ok(s, `the search row must render in the embedder-down probe — got ${JSON.stringify(embedderDown.before?.odmRows)}`);
  assert.equal(s.okDot, false, 'a failed embedder must NOT paint the green "Included" dot — that is the fresh-install lie');
  assert.equal(s.badDot, true, 'a down embedder is a genuine fault — red, not muted, not green');
  assert.equal(s.hasRetry, true, 'and it must offer a Retry — the bundled model can re-attempt its HF download');
  assert.match(String(s.retryText), /retry/i, `the button reads "Retry" (a re-attempt, not a fresh download) — got "${s.retryText}"`);
  assert.equal(s.hasDownload, false, 'never a "Download" over a bundled model — it ships in the app, it just did not finish loading');
  // …and the click reaches the retry endpoint — never a forked /hardware/pull or /transcription path.
  const r = embedderDown.odmRetry;
  assert.ok(r?.hadButton, 'the Retry button must be present for the click-drive');
  assert.ok(r.sent.some((x) => x.path === '/portal/embed/retry' && x.method === 'POST'),
    `the Retry must POST /portal/embed/retry (the nudge-supervisor path). Sent: ${JSON.stringify(r.sent)}`);
  assert.ok(!r.sent.some((x) => /\/hardware\/pull|\/transcription\/download/.test(x.path)),
    `and NEVER a fresh model download — Search is bundled. Sent: ${JSON.stringify(r.sent)}`);
});

t('F23. ⭐ QA6 §1 — a RUNTIME-down Understanding offers "Retry connection" → /portal/hardware/retry, never a Download', () => {
  // The operator-reported strand: the categorize (Understanding) model runs on Ollama, so a
  // daemon that isn't answering reads 'down' with the runtime-unreachable line — and there was
  // NOTHING to press. The panel must now offer "Retry connection" (the daemon's OWN ensureUp via
  // POST /portal/hardware/retry), and NEVER a Download (the model file is fine, the daemon isn't).
  assert.equal(runtimeDown.ok, true, String(runtimeDown.error || '').slice(0, 200));
  const u = (runtimeDown.before?.odmRows || []).find((r) => r.key === 'understanding');
  assert.ok(u, `the understanding row must render — got ${JSON.stringify(runtimeDown.before?.odmRows)}`);
  assert.equal(u.badDot, true, 'a runtime-down model is a genuine fault — red');
  assert.equal(u.hasRetryRuntime, true, 'it must offer "Retry connection"');
  assert.match(String(u.retryRuntimeText), /retry connection/i, `the button reads "Retry connection" — got "${u.retryRuntimeText}"`);
  assert.equal(u.hasDownload, false, 'never a Download over a model whose RUNTIME is the blocker');
  const rr = runtimeDown.odmRetryRuntime;
  assert.ok(rr?.understandingHasRetryRuntime, 'the retry-runtime button must be present for the click-drive');
  assert.equal(rr.understandingHasDownload, false, 'and no Download button beside it');
  assert.equal(rr.ollamaRetryHits, 1, `clicking it must POST /portal/hardware/retry exactly once — got ${rr.ollamaRetryHits}`);
  // The Transcription row (whisper engine down) gets the same affordance, routed to its own service.
  assert.equal(rr.transcriptionHasRetryRuntime, true, 'a down transcription engine also offers "Retry connection"');
  assert.equal(rr.transRetryHits, 1, `and it POSTs /portal/transcription/retry once — got ${rr.transRetryHits}`);
});

t('F24. ⭐ QA6 §1 (LOW-5) — the Understanding row reads the DAEMON health, not a stale slice "ok"', () => {
  // The strand this closes: the categorize/Understanding model runs on the Ollama daemon, but the row
  // derived only from the readiness `models` slice. When that slice reports a STALE labeler 'ok' while
  // the daemon is genuinely down (GET /portal/hardware/ollama), the row painted a false green. The
  // client now MERGES the daemon's true health (withOllama) so the panel reads the fault + offers
  // "Retry connection". A reverted merge would read the slice's 'ok' → okDot, no retry → this REDs.
  assert.equal(ollamaStrand.ok, true, String(ollamaStrand.error || '').slice(0, 200));
  const u = (ollamaStrand.before?.odmRows || []).find((r) => r.key === 'understanding');
  assert.ok(u, `the understanding row must render — got ${JSON.stringify(ollamaStrand.before?.odmRows)}`);
  assert.equal(u.okDot, false, 'a down DAEMON must not read green just because the slice cached an "ok" labeler');
  assert.equal(u.badDot, true, 'the daemon fault is the truer state — red');
  assert.equal(u.hasRetryRuntime, true, 'and it offers "Retry connection" (the daemon\'s own bring-up path)');
  assert.equal(u.hasDownload, false, 'never a Download — the model file is fine, the daemon is the blocker');
});

t('F10. A8 — a genuine fault gets a red line WITH a control; a choice renders muted, never red', () => {
  assert.match(String(fault.before.needsLine), /isn’t working/, 'the down member must surface as the one "needs you" line');
  assert.equal(fault.before.faultHasControl, true, 'no rendered fault without a next step');
  // Phase 3: the local models render in the PANEL now, so the fault verdict is read there. The
  // needs-line above still fires off the full summaryRows logic (faultRow), even though the local
  // rows aren't in the cloud-only summary render.
  const p = Object.fromEntries((fault.before.odmRows || []).map((r) => [r.key, r]));
  assert.equal(p.understanding?.badDot, true, 'a DOWN labeler ⇒ red in the panel');
  assert.equal(p.transcription?.badDot, false, 'an unset whisper is a muted CHOICE — never red, never a spinner (§8.2)');
  assert.equal(p.voice?.badDot, false, 'voice unset is the user\'s state, not an error');
});

t('F21. ⭐ Phase 3 de-dup — local models render ONCE (the panel); the summary shows only CLOUD functions', () => {
  // The operator's "too much duplication": local models used to appear as summary dots AND panel
  // rows. Now the summary carries only Conversation + Descriptions (cloud), and the four local
  // models live solely in the On-device panel — no double-listing, no two surfaces to disagree.
  const sumLabels = (returning.before.dotClasses || []).map((d) => String(d.label));
  const LOCAL = ['Understanding your messages', 'Search', 'Transcription', 'Voice'];
  for (const l of LOCAL) assert.ok(!sumLabels.includes(l), `"${l}" must NOT be a summary row — it lives in the panel now. Summary: ${JSON.stringify(sumLabels)}`);
  assert.deepEqual(sumLabels.sort(), ['Conversation', 'Narration'], `the summary shows only the cloud functions — got ${JSON.stringify(sumLabels)}`);
  // …and the four local models ARE in the panel (F16 asserts the set; here we pin they moved OUT
  // of the summary and INTO the panel, i.e. exactly once total).
  const panelKeys = (returning.before.odmRows || []).map((r) => r.key).sort();
  assert.deepEqual(panelKeys, ['search', 'transcription', 'understanding', 'voice'], 'all four local models are in the panel');
});

t('F11. ⭐ A3 — the demoted AISettings carries NO assignment machinery (mounted, not grepped)', () => {
  assert.deepEqual(ai.taskModelCalls, [], 'it must never touch /providers/task-models — reads included: the second writer is gone');
  assert.equal(ai.saysPerTask, false, 'the "Models per task" lane is gone');
  assert.equal(ai.saysWhisper, false, 'the whisper rail is gone (it lives under the Transcription function row now)');
  assert.equal(ai.hasAssistantNameInput, false, 'the name/personality editor is gone (character page\'s job)');
  assert.equal(ai.heroPresent, false, 'the active-model hero is gone (the summary card owns that fact)');
  assert.equal(ai.selectCount, 0, 'no <select> at all in the demoted mount (the sub-model select renders only when a subscription is connected)');
});

t('F12. ⭐ emptiness is a VERIFIED fact — a failed providers read never renders the first-run card', () => {
  // The onboarding-status lesson: a cold-vault CLAIM ("you have never set anything up") must be
  // earned by real reads that returned empty. A transient 500 rendering "Give Mycelium a brain"
  // over a configured vault would invite re-running setup on top of live state.
  assert.equal(readfail.ok, true, String(readfail.error || '').slice(0, 200));
  assert.equal(readfail.before.state, null, `no state card may render off a failed read. Got: ${readfail.before.state}`);
  assert.match(readfail.before.text, /Could not load your intelligence settings/,
    'the honest error line renders — never a fake bundle from a hardcoded taxonomy (§7)');
});

t('F11b. P3 — demoted is not DELETED: connect + manage all still stand', () => {
  assert.equal(ai.hasLocalLane, true, 'the Local lane (hardware recommender) survives');
  assert.equal(ai.hasCloudPresets, true, 'the Cloud presets survive');
  assert.equal(ai.hasSubscriptionCard, true, 'the #133 Claude ladder survives');
  assert.equal(ai.hasWebAccess, true, 'web access survives');
  assert.equal(ai.hasConnectedList, true, 'the connected-providers list survives');
});

// ── auth VALIDITY: "connected" must mean VALID (2026-07-18) ────────────────────────────────
rec('F13a. the validity probes mount', subSplit.ok === true && subOk.ok === true && subUnknown.ok === true,
  [subSplit, subOk, subUnknown].map((x) => x.error || '').filter(Boolean).join(' | ').slice(0, 300));

t('F13. ⭐ subscription "connected" is EVIDENCE, not row-existence — unknown renders MUTED, ok renders green', () => {
  // The bug this ends: a stored oauth row rendered a green "Claude subscription" while the
  // credential had been expired-beyond-refresh for four days. Identity of the rendered state:
  assert.equal(subOk.subProbe?.dot, 'ok', `positive evidence ⇒ green. Got: ${subOk.subProbe?.dot}`);
  assert.equal(subOk.subProbe?.what, 'Claude subscription', 'and plain copy — no qualifier needed when it works');
  assert.equal(subUnknown.subProbe?.dot, 'choice',
    `ZERO evidence must NOT claim connected — muted, never green (fail-closed). Got: ${subUnknown.subProbe?.dot}`);
  assert.ok(!/reconnect/i.test(String(subUnknown.subProbe?.what)),
    'and no scare copy either — unknown is neutral, not an alarm');
  assert.equal(subUnknown.subProbe?.needsLine, null, 'unknown raises no needs-you line');
});

t('F14. ⭐ PER-SURFACE truth — chat alive + channels dead says BOTH; a blanket state lies about one', () => {
  // The live mismatch this encodes: the native wire rode a dead isolated-dir token (channel
  // replies 401) while the spawned Claude Code engine answered fine on its own login. A single
  // "connected" was wrong for channels; a single "dead" would be wrong for chat.
  assert.equal(subSplit.subProbe?.dot, 'bad', 'a broken surface is a genuine fault — red dot');
  assert.match(String(subSplit.subProbe?.what), /chat works; background replies need reconnect/,
    `the row must state the SPLIT, not a blanket verdict. Got: ${subSplit.subProbe?.what}`);
  assert.match(String(subSplit.subProbe?.needsLine), /Claude account/,
    'and the needs-you line names the credential, not a generic "isn\'t working"');
});

t('F15. ⭐ Refresh now hits the refresh route; failure ESCALATES to reconnect; NOTHING auto-opens', () => {
  assert.equal(subSplit.subProbe?.hasRefreshBtn, true, 'needs_reconnect must offer the one-click refresh');
  assert.equal(subSplit.subProbe?.hasReconnectBtn, true, 'and the existing reconnect ladder');
  assert.deepEqual(subSplit.subProbe?.afterRefresh?.refreshPosts, ['POST'],
    'the button drives POST /portal/auth/claude/refresh — the existing ToS-clean path, no new auth flow');
  assert.equal(subSplit.subProbe?.afterRefresh?.escalation, true,
    'a failed refresh must SAY the next step is signing in again — not silently stay red');
  assert.equal(subSplit.subProbe?.afterRefresh?.stillBad, true,
    'and must NOT flip the dot green off a failed attempt (the route-claims-ok mutation reds here)');
  // The auto-open canary: ~5 unprompted sign-in windows is a live bug elsewhere; the status
  // surface must be structurally unable to contribute. windowOpens counts EVERY window.open.
  assert.equal(subSplit.subProbe?.windowOpens, 0, 'status/refresh logic never opens a window');
  assert.equal(subSplit.windowOpens, 0, 'nor does anything else in this pane during the probe');
});

// ── D-074: the cloud model list is the PROVIDER'S ANSWER, never a roster ────────────────────
// The defect: AISettings.svelte carried a four-entry `CLAUDE_SUB_MODELS` array and merely
// APPENDED the server's answer to it. A model released after that array was typed either never
// appeared (the OAuth token often lacks models:list scope, and the pull failed SILENTLY) or
// appeared last, under four ids that looked like the real menu. Meta-defect M-002.
rec('F25a. the subscription probes mount', aiSub.ok === true && aiSubStale.ok === true,
  [aiSub, aiSubStale].map((x) => x.error || '').filter(Boolean).join(' | ').slice(0, 300));

t('F25. ⭐ D-074 — the model options ARE the provider\'s answer; no literal roster survives', () => {
  const pick = aiSub.subPicker;
  assert.ok(pick?.present, `a connected subscription must render the model picker — got ${JSON.stringify(pick)}`);
  // The served fixture is ['claude-opus-5', 'claude-sonnet-4-6'] — 'claude-opus-5' has never
  // existed in any list in this repo, so it can ONLY be here by coming from the response.
  assert.ok(pick.optionValues.includes('claude-opus-5'),
    `a model the provider returned must be offered — this is the operator's report verbatim ("Opus 5 is available, the picker shows our pre-made selection"). Got: ${JSON.stringify(pick.optionValues)}`);
  // …and NOTHING the provider did not return. The four ids below are precisely the deleted
  // roster: if any reappears while the provider returned two models, a literal list is back.
  const model = pick.optionValues.filter((v) => v !== '');
  assert.deepEqual(model, ['claude-opus-5', 'claude-sonnet-4-6'],
    `the options must be EXACTLY the served list — a merged roster shows up here as extra ids (claude-opus-4-8 / claude-sonnet-5 / claude-fable-5 / claude-haiku-4-5). Got: ${JSON.stringify(model)}`);
  // A live answer carries NO qualifier — the honest-state line is for stale lists only, or it
  // becomes noise the user learns to ignore (and then misses when it matters).
  assert.equal(pick.note, null, `a LIVE list must render unqualified — got ${JSON.stringify(pick.note)}`);
});

t('F25b. ⭐ …and a list that is NOT current SAYS SO — never a stale list dressed as live', () => {
  const pick = aiSubStale.subPicker;
  assert.ok(pick?.present, 'the picker must still render when the provider cannot be listed — never a dead end');
  assert.ok(pick.optionValues.length > 1,
    `and must still offer something selectable (the dated MODEL_REGISTRY floor). Got: ${JSON.stringify(pick.optionValues)}`);
  assert.ok(pick.note && pick.note.length > 0,
    'a fallback list MUST carry an honest state — rendering it silently is the same lie as the roster, with fewer entries');
  assert.match(String(pick.note), /list models|reach|unavailable/i,
    `and the line must say WHY, so the user can act on it. Got: ${JSON.stringify(pick.note)}`);
  // The reason is a CATEGORY. Nothing about the credential may reach the UI (CLAUDE.md §1/§4).
  assert.ok(!/sk-ant|Bearer|x-api-key/i.test(String(pick.note)),
    `the honest state must never carry credential material. Got: ${JSON.stringify(pick.note)}`);
});

t('F25d. ⭐ …and the FALLBACK floor is not smaller than the roster it replaced (review MED)', () => {
  // The deleted CLAUDE_SUB_MODELS carried claude-sonnet-5 and claude-fable-5, and neither was in
  // MODEL_REGISTRY — so the first version of this fix made the offline picker offer a STRICTLY
  // SMALLER, OLDER set than before, on the very path the operator's symptom lives (an OAuth token
  // without models:list scope). A user running Sonnet 5 could not re-select it. The rows were
  // consolidated into the one dated table; this asserts the floor covers the retired roster.
  //
  // Asserted against the REAL fallbackModelsFor, not the fixture — the sub-stale probe serves a
  // deliberately short list, so a fixture check would prove nothing about the product.
  const floor = fallbackModelsFor('anthropic');
  for (const id of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5']) {
    assert.ok(floor.includes(id),
      `the offline floor must still offer ${id} — it was selectable before D-074 deleted the roster. Floor: ${JSON.stringify(floor)}`);
  }
  // …and it is DERIVED (family-filtered), not a copy of the roster: a local model must not leak in.
  assert.ok(!floor.some((m) => /qwen|llama|gemma|mistral|phi/.test(m)),
    `the Claude floor must be family-filtered from MODEL_REGISTRY, not the whole table. Floor: ${JSON.stringify(floor)}`);
});

t('F25e. ⭐ …and the "default" option NAMES the model, never asserts a plan-derived one (review MED)', () => {
  // An earlier draft labelled the empty option "Default for your plan" — plan-derivation the app
  // does not have, and it HID which model runs. That is the same dishonesty as the stale roster:
  // the user reads a reassuring label and gets whatever `DEFAULT_ANTHROPIC_CHAT_MODEL` happens to
  // be. The label now renders the id the SERVER sent (route → src/agent/harness.js).
  const pick = aiSub.subPicker;
  const label = (pick.optionLabels || [])[(pick.optionValues || []).indexOf('')];
  assert.ok(label, `the empty-value option must exist — got ${JSON.stringify(pick.optionLabels)}`);
  assert.ok(!/for your plan/i.test(String(label)),
    `the option must not claim a plan-derived default — got "${label}"`);
  assert.match(String(label), /Opus 4\.8|claude-opus-4-8/,
    `it must NAME the served default (claude-opus-4-8 in this fixture) so the user can see what runs — got "${label}"`);
  // …and it must SCOPE the claim. The served default is DEFAULT_ANTHROPIC_CHAT_MODEL, but the
  // same empty model_preference runs cloud.js's DEFAULT_ANTHROPIC_MODEL on narrate/enrich — a
  // DIFFERENT model. Naming one unqualified promises it for every job and delivers another on
  // half of them, which is the stale-roster dishonesty in miniature (independent review ×2, MED).
  assert.match(String(label), /for chat/i,
    `naming the chat default without scoping it to chat promises one model and runs another on narrate/enrich — got "${label}"`);
});

t('F25c. ⭐ …and Refresh BYPASSES the cache — otherwise a newly-released model still cannot appear', () => {
  // The server caches the discovered list (5-min TTL) so the picker does not hit the provider on
  // every render. That cache is only safe because the explicit Refresh can jump it: without
  // ?refresh=1 the button re-reads the same cached answer and the user is told nothing changed.
  const pick = aiSub.subPicker;
  assert.ok(pick.refreshPaths.some((p) => /\/models\?refresh=(1|true)/.test(p)),
    `the Refresh click must request a forced re-discovery. Got: ${JSON.stringify(pick.refreshPaths)}`);
  // …and the list is discovered on LOAD too, not only behind a click nobody presses.
  assert.ok(pick.modelPaths.some((p) => !/refresh=/.test(p)),
    `the picker must discover the list at mount as well. Got: ${JSON.stringify(pick.modelPaths)}`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the Intelligence pane is a flow: one confirm, honest totals, one assignment surface, one live region' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
