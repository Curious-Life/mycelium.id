// verify:tts-kokoro — the local-TTS outbound path end to end, WITHOUT real
// Kokoro or Telegram: a stub HTTP service returns a WAV, and we drive the real
// synthesizeForTelegram() to prove provider → pure-JS OGG/Opus encode → a
// Telegram-ready chunk. Also checks fail-closed config.
import http from 'node:http';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

function sineWav({ freq = 220, seconds = 1.2, rate = 24000 }) {
  const n = Math.floor(rate * seconds), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 0.6 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// stub kokoro-service: POST /tts → 24k mono WAV
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/tts') {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const wav = sineWav({});
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav);
    });
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// configure the local provider to hit the stub
process.env.KOKORO_TTS_ENABLED = '1';
process.env.KOKORO_TTS_URL = `http://127.0.0.1:${port}`;
process.env.TTS_PROVIDER = 'kokoro';

const tts = await import('../packages/channel-daemon/tts/index.js');
const { readFile, stat } = await import('node:fs/promises');

// K1) provider selected + enabled
rec('K1. kokoro provider resolves + isEnabled() with the per-box opt-in', tts.isEnabled() && tts.getConfig().providerName === 'kokoro', JSON.stringify(tts.getConfig()));

// K2) full synth path → Telegram-ready OGG/Opus chunks
const chunks = [];
for await (const c of tts.synthesizeForTelegram('This is a local text to speech test for the mycelium vault on telegram.', { agentId: 'test-bot' })) chunks.push(c);
const okChunks = chunks.filter((c) => c.ok);
rec('K2. synthesizeForTelegram yields at least one ok chunk', okChunks.length >= 1, `chunks=${chunks.length} ok=${okChunks.length}` + (chunks.find(c => !c.ok) ? ` err=${chunks.find(c=>!c.ok).error}` : ''));

if (okChunks.length) {
  const c = okChunks[0];
  let head = '', size = 0;
  try { const buf = await readFile(c.path); head = buf.subarray(0, 4).toString('latin1'); size = (await stat(c.path)).size; } catch (e) { head = `(err ${e.message})`; }
  rec('K3. chunk file is real OGG/Opus (starts with "OggS") — pure-JS encode, no ffmpeg', head === 'OggS', `head="${head}" size=${size}`);
  rec('K4. chunk reports a sane size + voiceUsed', c.size > 200 && typeof c.voiceUsed === 'string', `size=${c.size} voice=${c.voiceUsed}`);
  for (const ch of chunks) await ch.cleanup?.();
}

// K3b) fail-closed: explicit provider not configured → disabled (never silently cloud)
delete process.env.KOKORO_TTS_ENABLED; delete process.env.KOKORO_TTS_URL;
const tts2 = await import('../packages/channel-daemon/tts/config.js?2');
rec('K5. with the opt-in off, kokoro is not configured → resolveProvider null (fail-closed)', tts2.resolveProvider() === null);

server.close();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(70));
console.log(`VERDICT: ${allPass ? 'GO — local kokoro provider → pure-JS OGG/Opus → Telegram-ready chunk; fail-closed when off' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(70));
process.exit(allPass ? 0 : 1);
