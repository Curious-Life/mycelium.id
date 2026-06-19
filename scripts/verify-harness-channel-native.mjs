// verify:harness-channel-native — the daemon's native backend forwarder
// (packages/channel-daemon/agent/backends/native.js) + the selectRuntime wire. Spec §6/H11.
//   N1 forwards the correct body (conversationId = bare chatId, userMessage, source)
//   N2 maps the server response {delivered,usedReplyTool,reason}
//   N3 group derived from channelKind ('…-group' → group:true, addressed:false)
//   N4 DM ('telegram' → group:false, addressed:true)
//   N5 non-200 server → soft-fail {delivered:false, reason:'server-NNN'}
//   N6 forward failure (no server) → {delivered:false, reason:'native-forward-failed'}
//   N7 selectRuntime(channelRouter:'native') → the native runtime, no creds needed
import http from 'node:http';
import { createNativeRuntime } from '../packages/channel-daemon/agent/backends/native.js';
import { selectRuntime } from '../packages/channel-daemon/agent/runtime.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// Fake server: records the last body, returns a programmable response/status.
let lastBody = null; let nextStatus = 200; let nextJson = { delivered: true, usedReplyTool: true, reason: 'replied' };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { lastBody = JSON.parse(raw); } catch { lastBody = null; } res.writeHead(nextStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify(nextJson)); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const rt = createNativeRuntime({ vaultBaseUrl: `http://127.0.0.1:${port}` });

// ── N1 + N2 DM forward + mapping ──
{
  nextStatus = 200; nextJson = { delivered: true, usedReplyTool: true, reason: 'replied' };
  const out = await rt.runTurn({ turnCtx: { source: 'telegram', channelKind: 'telegram', channelId: 12345 }, userMessage: 'hello' });
  rec('N1 forwards conversationId=bare chatId + userMessage + source', lastBody?.conversationId === '12345' && lastBody?.userMessage === 'hello' && lastBody?.source === 'telegram', JSON.stringify(lastBody));
  rec('N2 maps the server response', out.delivered === true && out.usedReplyTool === true && out.reason === 'replied');
  rec('N1 label is native', rt.label === 'native');
}

// ── N3 group ──
{
  await rt.runTurn({ turnCtx: { source: 'telegram-group', channelKind: 'telegram-group', channelId: 999 }, userMessage: 'hi all' });
  rec('N3 group derived from channelKind → group:true, addressed:false', lastBody?.group === true && lastBody?.addressed === false, JSON.stringify({ g: lastBody?.group, a: lastBody?.addressed }));
}

// ── N4 DM ──
{
  await rt.runTurn({ turnCtx: { source: 'telegram', channelKind: 'telegram', channelId: 7 }, userMessage: 'yo' });
  rec('N4 DM → group:false, addressed:true', lastBody?.group === false && lastBody?.addressed === true);
}

// ── N5 non-200 ──
{
  nextStatus = 500; nextJson = { error: 'boom' };
  const out = await rt.runTurn({ turnCtx: { source: 'telegram', channelKind: 'telegram', channelId: 1 }, userMessage: 'x' });
  rec('N5 non-200 → soft-fail with server-NNN code', out.delivered === false && out.reason === 'server-500', JSON.stringify(out));
  nextStatus = 200;
}

// ── N6 forward failure ──
{
  const dead = createNativeRuntime({ vaultBaseUrl: 'http://127.0.0.1:1' }); // nothing listening
  const out = await dead.runTurn({ turnCtx: { source: 'telegram', channelKind: 'telegram', channelId: 1 }, userMessage: 'x' });
  rec('N6 forward failure → native-forward-failed (no throw, no auto-replay)', out.delivered === false && out.reason === 'native-forward-failed', JSON.stringify(out));
}

// ── N7 selectRuntime wire ──
{
  const sel = selectRuntime({ channelRouter: 'native', vaultBaseUrl: `http://127.0.0.1:${port}` });
  rec('N7 selectRuntime(native) → native runtime, no model creds required', sel && sel.label === 'native' && typeof sel.runTurn === 'function');
  // RT4 flip: native is now the DEFAULT (no explicit override, no daemon creds). The
  // server resolves the provider; honesty is enforced at boot via probeHealth.
  const def = selectRuntime({ vaultBaseUrl: `http://127.0.0.1:${port}` });
  rec('N7 native is the DEFAULT now (no router → native, RT4 flip)', def && def.label === 'native' && typeof def.runTurn === 'function');
  rec('N7 native exposes probeHealth (B1 honest capture-only)', typeof sel.probeHealth === 'function');
  // explicit overrides still win + still fail-closed when their creds are absent.
  rec('N7 explicit cloud override w/ no key → null (fail-closed)', selectRuntime({ channelRouter: 'cloud' }) === null);
}

await new Promise((r) => server.close(r));
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — native backend: forwards (chatId · userMessage · group-derive · addressed) · maps response · soft-fails (server-NNN · forward-failed) · selectRuntime opt-in wire' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
