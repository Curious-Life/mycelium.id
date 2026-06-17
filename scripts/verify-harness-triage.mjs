// verify:harness-triage — the channel reply/skip gate (src/agent/triage.js), pure. Spec §6.
//   TR1 DM → always reply
//   TR2 group + addressed → reply
//   TR3 group + not addressed + no name → skip
//   TR4 group + name mention in text → reply (heuristic fallback)
//   TR5 model triage (flag-gated): yes→reply, no→skip, throw→heuristic skip; off by default
import { triageHeuristic, createTriage } from '../src/agent/triage.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── TR1–TR4 heuristic ──
{
  rec('TR1 DM always replies', triageHeuristic({ text: 'hello', group: false }).reply === true);
  rec('TR2 group + addressed → reply', triageHeuristic({ text: 'hi', group: true, addressed: true }).reason === 'addressed');
  const skip = triageHeuristic({ text: 'just chatting amongst ourselves', group: true, addressed: false, agentName: 'Mycelium' });
  rec('TR3 group + not addressed + no mention → skip', skip.reply === false && skip.reason === 'group-not-addressed');
  const mention = triageHeuristic({ text: 'hey Mycelium can you help', group: true, addressed: false, agentName: 'Mycelium' });
  rec('TR4 group + name mention → reply (fallback)', mention.reply === true && mention.reason === 'name-mention');
  rec('TR4 substring of a longer word does NOT count as a mention', triageHeuristic({ text: 'myceliumish nonsense', group: true, agentName: 'Mycelium' }).reply === false);
}

// ── TR5 model triage path (default OFF) ──
{
  const off = createTriage({ agentName: 'Mycelium' }); // groupModelTriage default false
  let classified = 0;
  const offDecision = await off({ text: 'ambiguous group line', group: true, addressed: false });
  rec('TR5 model triage OFF by default → heuristic skip, no classify', offDecision.reply === false && offDecision.reason === 'group-not-addressed');

  const yes = createTriage({ agentName: 'Mycelium', groupModelTriage: true, modelClassify: async () => { classified += 1; return true; } });
  const yesD = await yes({ text: 'is anyone able to help with X?', group: true, addressed: false });
  rec('TR5 model triage ON + yes → reply (model-yes)', yesD.reply === true && yesD.reason === 'model-yes' && classified === 1);

  const no = createTriage({ agentName: 'Mycelium', groupModelTriage: true, modelClassify: async () => false });
  rec('TR5 model triage ON + no → skip (model-no)', (await no({ text: 'lol', group: true, addressed: false })).reason === 'model-no');

  const err = createTriage({ agentName: 'Mycelium', groupModelTriage: true, modelClassify: async () => { throw new Error('down'); } });
  const errD = await err({ text: 'hmm', group: true, addressed: false });
  rec('TR5 model triage error → fail-safe heuristic skip (no throw)', errD.reply === false && errD.reason === 'group-not-addressed');

  // DM never reaches the model path even when enabled.
  let dmClassified = 0;
  const dm = createTriage({ agentName: 'Mycelium', groupModelTriage: true, modelClassify: async () => { dmClassified += 1; return false; } });
  rec('TR5 DM short-circuits before model triage', (await dm({ text: 'hi', group: false })).reply === true && dmClassified === 0);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — triage: DM-always · addressed-group · name-mention fallback · word-boundary safe · model-triage (off-by-default · yes/no · fail-safe skip)' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
