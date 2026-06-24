// verify:channel-tts — the CI-testable parts of the harvested TTS module
// (markdown strip, chunking, config/provider/voice resolution, isEnabled,
// error classes, disabled + short-text paths). The provider HTTP calls + ffmpeg
// remux are host-verified (need API keys + ffmpeg). PASS/FAIL; exit 1 on fail.
import { stripMarkdownForTTS } from '../packages/channel-daemon/tts/shared/markdown.js';
import { splitTextForTTS } from '../packages/channel-daemon/tts/shared/chunking.js';
import { resolveProvider, resolveVoice, isEnabled } from '../packages/channel-daemon/tts/config.js';
import * as tts from '../packages/channel-daemon/tts/index.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// keep the env clean between cases
for (const k of Object.keys(process.env)) if (/^(OPENAI|ELEVENLABS|TTS|AGENT_ID)/.test(k)) delete process.env[k];

// ── markdown strip ───────────────────────────────────────────────────────────
{
  const out = stripMarkdownForTTS('# Title\n\nHello **bold** and `code` and [link](http://x).\n```\nblock\n```');
  rec('T1. markdown strip removes code/heading/bold markers', !out.includes('**') && !out.includes('`') && !out.includes('#') && /Hello/.test(out) && /link/.test(out), `out=${JSON.stringify(out.slice(0, 50))}`);
}

// ── chunking ─────────────────────────────────────────────────────────────────
{
  const long = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const chunks = splitTextForTTS(long, 120);
  rec('T2. chunking splits long text', chunks.length > 1, `chunks=${chunks.length}`);
  rec('T3. every chunk within maxLen', chunks.every((c) => c.length <= 120), `max=${Math.max(...chunks.map((c) => c.length))}`);
  rec('T4. chunks rejoin to the source (no loss)', chunks.join(' ').replace(/\s+/g, ' ').trim() === long.replace(/\s+/g, ' ').trim());
  rec('T5. short text → single chunk', splitTextForTTS('just one.', 120).length === 1);
}

// ── no pre-truncation: long replies are chunked IN FULL, never cut at a char cap ──
{
  // Defaults are now unbounded — synthesizeFor* no longer substring-truncates the
  // text before chunking (was 50k Telegram / 6k Discord, which dropped the tail).
  rec('T5a. TTS default caps are unbounded (no pre-truncation)',
    tts.TELEGRAM_DEFAULT_MAX_TEXT_CHARS === Infinity && tts.DISCORD_DEFAULT_MAX_TEXT_CHARS === Infinity,
    `tg=${tts.TELEGRAM_DEFAULT_MAX_TEXT_CHARS} dc=${tts.DISCORD_DEFAULT_MAX_TEXT_CHARS}`);
  // A reply well past the OLD 50k cap must chunk losslessly (every char survives).
  const huge = Array.from({ length: 4000 }, (_, i) => `This is sentence ${i} of a very long reply.`).join(' ');
  const chunks = splitTextForTTS(huge, 4096);
  const lossless = chunks.join(' ').replace(/\s+/g, ' ').trim() === huge.replace(/\s+/g, ' ').trim();
  rec('T5b. >50k-char reply chunks losslessly (old 50k/6k cap would have dropped the tail)',
    huge.length > 50000 && chunks.length > 12 && lossless, `len=${huge.length} chunks=${chunks.length} lossless=${lossless}`);
}

// ── config: provider + voice resolution (config-implied) ─────────────────────
{
  rec('T6. isEnabled false with no provider configured', isEnabled() === false && resolveProvider() === null);

  process.env.OPENAI_API_KEY = 'sk-test';
  const p = resolveProvider();
  rec('T7. OPENAI_API_KEY → openai provider + isEnabled true', !!p && p.name === 'openai' && isEnabled() === true, `provider=${p?.name}`);
  rec('T8. resolveVoice falls back to provider default', typeof resolveVoice(p) === 'string' && resolveVoice(p).length > 0, `voice=${resolveVoice(p)}`);

  process.env.OPENAI_TTS_VOICE = 'sage';
  rec('T9. OPENAI_TTS_VOICE overrides the default', resolveVoice(p) === 'sage');

  process.env.TTS_VOICE_PERSONAL_AGENT = 'shimmer';
  rec('T10. per-agent voice override wins', resolveVoice(p, 'personal-agent') === 'shimmer');
  delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_TTS_VOICE; delete process.env.TTS_VOICE_PERSONAL_AGENT;
}

// ── error classes ────────────────────────────────────────────────────────────
{
  rec('T11. error classes exported', typeof tts.TTSError === 'function' && typeof tts.TTSDisabledError === 'function' && typeof tts.TTSProviderError === 'function');
}

// ── generator paths that DON'T hit the network ───────────────────────────────
{
  // no provider → throws TTSDisabledError on first iteration
  let threw = null;
  try { for await (const _ of tts.synthesizeForTelegram('hello world this is long enough')) { /* */ } } catch (e) { threw = e; }
  rec('T12. synthesizeForTelegram with no provider → TTSDisabledError', threw instanceof tts.TTSDisabledError, `threw=${threw?.constructor?.name}`);

  // provider set but text too short → yields nothing, no network call
  process.env.OPENAI_API_KEY = 'sk-test';
  let count = 0;
  for await (const _ of tts.synthesizeForTelegram('hi')) count++;
  rec('T13. too-short text → no chunks, no provider call', count === 0);
  delete process.env.OPENAI_API_KEY;
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
