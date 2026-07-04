// verify:ollama-manifest — pulled-model manifest (src/hardware/ollama-manifest.js)
//   M1 recordPulledModel writes a tag; readPulledModels returns it; idempotent
//   M2 missing/garbled manifest reads as []
//   M3 makeDeleteOllamaModels: ok/notFound → removed; throw/!ok → failed; best-effort
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordPulledModel, readPulledModels, makeDeleteOllamaModels } from '../src/hardware/ollama-manifest.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const DIR = join(process.cwd(), 'data', 'verify-ollama-manifest');
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });

// M1
await recordPulledModel('llama3:8b', { dataDir: DIR });
await recordPulledModel('nomic-embed', { dataDir: DIR });
await recordPulledModel('llama3:8b', { dataDir: DIR }); // dup → idempotent
const list = await readPulledModels({ dataDir: DIR });
rec('M1 record + read, idempotent', JSON.stringify(list) === JSON.stringify(['llama3:8b', 'nomic-embed']), JSON.stringify(list));

// M2 garbled + missing
writeFileSync(join(DIR, 'ollama-pulled.json'), '{not json');
rec('M2 garbled → []', JSON.stringify(await readPulledModels({ dataDir: DIR })) === '[]');
rec('M2 missing → []', JSON.stringify(await readPulledModels({ dataDir: join(DIR, 'nope') })) === '[]');

// M3 delete hook
const client = {
  deleteModel: async (name) => {
    if (name === 'ok') return { ok: true };
    if (name === 'gone') return { ok: false, notFound: true };
    if (name === 'boom') throw new Error('daemon down');
    return { ok: false, status: 500 };
  },
};
const del = makeDeleteOllamaModels(client);
const r = await del(['ok', 'gone', 'boom', 'fail']);
rec('M3 delete hook: ok+notFound removed, throw+!ok failed, never throws',
  JSON.stringify(r.removed) === JSON.stringify(['ok', 'gone']) && JSON.stringify(r.failed) === JSON.stringify(['boom', 'fail']),
  JSON.stringify(r));

rmSync(DIR, { recursive: true, force: true });
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — ollama pulled-model manifest');
