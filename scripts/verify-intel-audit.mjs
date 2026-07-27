// verify:intel-audit — the pure units behind the Intelligence-settings audit fixes:
//   IA1 listModels(token) → Anthropic Bearer + Claude-Code identity headers (subscription),
//       vs IA2 listModels(apiKey) → x-api-key (BYOK, unchanged).
//   IA3 ollama.deleteModel → DELETE /api/delete {model,name}; 404 → notFound; invalid name throws.
//   IA4 readClaudeAccount → parses ~/.claude.json oauthAccount (email/plan); null when absent.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { listModels } from '../src/inference/models.js';
import { createOllamaClient } from '../src/hardware/ollama.js';
import { readClaudeAccount } from '../src/inference/claude-oauth.js';

const ledger = [];
const rec = (label, cond, detail = '') => { ledger.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  — ' + detail}`); };
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

// ── IA1/IA2 — listModels header selection (capture the request headers) ──
{
  let captured = null;
  const fetchImpl = async (_url, init) => { captured = init?.headers || {}; return okJson({ data: [{ id: 'claude-opus-4-8' }] }); };
  const r = await listModels({ provider: 'anthropic', token: 'sk-ant-oat-TEST', fetch: fetchImpl });
  const h = captured || {};
  rec('IA1 subscription token → Bearer + anthropic-beta + user-agent + x-app (no x-api-key)',
    r.ok && h.Authorization === 'Bearer sk-ant-oat-TEST' && /claude-code/.test(h['anthropic-beta'] || '') && /claude-cli/.test(h['user-agent'] || '') && h['x-app'] === 'cli' && !('x-api-key' in h),
    JSON.stringify({ ok: r.ok, h }));
}
{
  let captured = null;
  const fetchImpl = async (_url, init) => { captured = init?.headers || {}; return okJson({ data: [{ id: 'claude-x' }] }); };
  await listModels({ provider: 'anthropic', apiKey: 'sk-ant-api-KEY', fetch: fetchImpl });
  const h = captured || {};
  rec('IA2 BYOK apiKey → x-api-key (unchanged, no Bearer)', h['x-api-key'] === 'sk-ant-api-KEY' && !('Authorization' in h), JSON.stringify(h));
}

// ── IA3 — ollama.deleteModel ──
{
  let req = null;
  const fetchImpl = async (url, init) => { req = { url, method: init?.method, body: init?.body }; return { ok: true, status: 200 }; };
  const c = createOllamaClient({ fetch: fetchImpl });
  const r = await c.deleteModel('qwen3.5:4b');
  const body = req ? JSON.parse(req.body) : {};
  rec('IA3a deleteModel → DELETE /api/delete {model,name}', r.ok && /\/api\/delete$/.test(req.url) && req.method === 'DELETE' && body.model === 'qwen3.5:4b' && body.name === 'qwen3.5:4b', JSON.stringify({ r, req }));
}
{
  const c = createOllamaClient({ fetch: async () => ({ ok: false, status: 404 }) });
  const r = await c.deleteModel('nope:1b');
  rec('IA3b deleteModel 404 → { ok:false, notFound:true }', r.ok === false && r.notFound === true, JSON.stringify(r));
}
{
  const c = createOllamaClient({ fetch: async () => ({ ok: true, status: 200 }) });
  let threw = false;
  try { await c.deleteModel('../etc/passwd'); } catch { threw = true; }
  rec('IA3c deleteModel rejects an invalid model name (no traversal/injection)', threw);
}

// ── IA4 — readClaudeAccount ──
{
  const readImpl = async () => JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', seatTier: 'max', organizationName: 'Acme' } });
  const a = await readClaudeAccount({ readImpl });
  rec('IA4a readClaudeAccount → { email, plan, organization }', a?.email === 'me@example.com' && a?.plan === 'max' && a?.organization === 'Acme', JSON.stringify(a));
}
{
  rec('IA4b readClaudeAccount → null when file missing', (await readClaudeAccount({ readImpl: async () => { throw new Error('ENOENT'); } })) === null);
  rec('IA4c readClaudeAccount → null when no oauthAccount', (await readClaudeAccount({ readImpl: async () => '{}' })) === null);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — intel-audit units: subscription model-listing (Bearer) · BYOK unchanged · ollama delete-from-disk (validated) · account-email capture' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
