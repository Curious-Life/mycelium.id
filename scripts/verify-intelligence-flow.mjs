// verify:intelligence-flow — the Intelligence pane as a FLOW (Part I of
// docs/INTELLIGENCE-SCREEN-REDESIGN-2026-07-17.md), MOUNTED and driven for real.
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
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

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

let cold = {}, returning = {}, fault = {}, disklow = {}, readfail = {}, ai = {};
try { cold = drive('test/mount-intelligence-flow.mjs'); } catch (e) { cold = { error: String(e?.message || e) }; }
try { returning = drive('test/mount-intelligence-flow.mjs', 'returning'); } catch (e) { returning = { error: String(e?.message || e) }; }
try { fault = drive('test/mount-intelligence-flow.mjs', 'fault'); } catch (e) { fault = { error: String(e?.message || e) }; }
try { disklow = drive('test/mount-intelligence-flow.mjs', 'disklow'); } catch (e) { disklow = { error: String(e?.message || e) }; }
try { readfail = drive('test/mount-intelligence-flow.mjs', 'readfail'); } catch (e) { readfail = { error: String(e?.message || e) }; }
try { ai = drive('test/mount-ai-settings.mjs'); } catch (e) { ai = { error: String(e?.message || e) }; }

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

t('F8. ⭐ A10 — the pane is a FLOW: the four-component machinery is NOT visible until Customize opens', () => {
  for (const probe of [cold, returning]) {
    assert.equal(probe.before.aiSettingsMounted, false, 'AISettings must sit behind the CLOSED disclosure');
    assert.equal(probe.before.engineMounted, false, 'EngineSelector too — no longer the pane\'s first element');
    assert.equal(probe.before.assignmentMounted, false, 'and the assignment screen');
    assert.equal(probe.customize.aiSettingsMounted, true, '…and Customize opens ALL of it (the disclosure is a door, not a wall)');
    assert.equal(probe.customize.screenRendered, true, 'with the REAL IntelligenceScreen as the assignment child');
    assert.deepEqual(probe.customize.order, ['assignment', 'connect-manage', 'voice-character', 'engine'],
      'the §3 Customize order: assignment · connect & manage · voice · engine');
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

t('F10. A8 — a genuine fault gets a red line WITH a control; a choice renders muted, never red', () => {
  assert.match(String(fault.before.needsLine), /isn’t working/, 'the down member must surface as the one "needs you" line');
  assert.equal(fault.before.faultHasControl, true, 'no rendered fault without a next step');
  const dots = Object.fromEntries((fault.before.dotClasses || []).map((d) => [d.label, d.cls]));
  assert.equal(dots['Understanding your messages'], 'bad', 'down ⇒ red');
  assert.equal(dots['Transcription'], 'choice', 'unset ⇒ muted CHOICE — never red, never a spinner (§8.2)');
  assert.equal(dots['Voice'], 'choice', 'voice unset is the user\'s state, not an error');
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

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the Intelligence pane is a flow: one confirm, honest totals, one assignment surface, one live region' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
