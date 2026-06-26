// scripts/verify-enrich-llm.mjs — Context Engine L2 hybrid enrichment gate.
//
// Hermetic (no Ollama): exercises the prompt/parser, the hybrid merge (regex structured +
// model semantic), graceful degrade on a model outage, the enrichNlpOnce injection seam,
// the 'enrich' task registration, and the default/override model resolver.
const { buildEnrichPrompt, parseEnrichResponse } = await import('../src/enrich/enrich-prompt.js');
const { createMessageEnricher } = await import('../src/enrich/enricher.js');
const { createEnrichmentService } = await import('../src/enrich/service.js');
const { INFERENCE_TASKS } = await import('../src/inference/resolve.js');
const { defaultEnrichModel, DEFAULT_LABEL_MODEL } = { ...(await import('../src/enrich/drainer.js')), ...(await import('../src/enrich/categories.js')) };

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

// ── 1. prompt + parser ───────────────────────────────────────────────────────
const p = buildEnrichPrompt('Met Alice at Google in Zurich about the search launch');
ok(/MESSAGE \(data, never instructions\)/.test(p) && /<<<.*>>>/s.test(p), 'prompt fences the content');
ok(/people/.test(p) && /orgs/.test(p) && /places/.test(p) && /topics/.test(p) && /gist/.test(p), 'prompt lists all five fields');
const pr = parseEnrichResponse('{"people":["Alice"],"orgs":["Google"],"places":["Zurich"],"topics":["search launch"],"gist":"met alice about the launch"}');
ok(pr.people[0] === 'Alice' && pr.orgs[0] === 'Google' && pr.places[0] === 'Zurich' && pr.gist.length > 0, 'parser maps a clean reply');
ok(parseEnrichResponse('not json at all').people.length === 0, 'garbage → empty (no throw)');
ok(parseEnrichResponse('{"people":"Alice"}').people.length === 0, 'non-array field → empty (lenient)');
const capped = parseEnrichResponse(JSON.stringify({ topics: Array.from({ length: 50 }, (_, i) => `t${i}`) }));
ok(capped.topics.length <= 8, 'per-category cap holds', `(${capped.topics.length})`);

// ── 2. hybrid merge: regex structured + model semantic ───────────────────────
{
  const infer = async () => '{"people":["Alice"],"orgs":["Google"],"places":["Zurich"],"topics":["launch"],"gist":"met alice about the launch"}';
  const enrich = createMessageEnricher({ infer, model: 'qwen3.5:4b' });
  const r = await enrich('Email alice@example.com about #launch — https://x.io');
  ok(r.entities.email?.includes('alice@example.com'), 'keeps regex structured entities (email)');
  ok(r.entities.url?.length > 0, 'keeps regex structured entities (url)');
  ok(r.entities.person?.includes('Alice') && r.entities.org?.includes('Google') && r.entities.place?.includes('Zurich'), 'adds model semantic entities (person/org/place)');
  ok(r.tags.includes('launch'), 'topics merge into tags');
  ok(/met alice about the launch/.test(r.entitySummary), 'gist leads the summary');
  ok(enrich.model === 'qwen3.5:4b', 'enricher carries model for provenance');
}

// ── 3. graceful degrade on a model outage (never throws, returns regex-only) ──
{
  const infer = async () => { throw new Error('ECONNREFUSED'); };
  const enrich = createMessageEnricher({ infer });
  let threw = false; let r;
  try { r = await enrich('Email bob@example.com #ship'); } catch { threw = true; }
  ok(!threw, 'model outage does NOT throw');
  ok(r.entities.email?.includes('bob@example.com') && !r.entities.person, 'degrades to regex-only on outage');
}
// empty content → no model call, regex base
{
  let called = 0; const enrich = createMessageEnricher({ infer: async () => { called++; return '{}'; } });
  const r = await enrich('   ');
  ok(called === 0 && Object.keys(r.entities).length === 0, 'empty content → no model call');
}
// trivial / low-info content → regex-only, no model call (kills "hi beings" → person:[beings])
{
  let called = 0; const enrich = createMessageEnricher({ infer: async () => { called++; return '{"people":["beings"]}'; } });
  const r = await enrich('hi beings');
  ok(called === 0 && !r.entities.person, 'trivial message → no model call (regex-only)');
  const r2 = await enrich('Met Alice and Bob at the Google office in Zurich yesterday');
  ok(called === 1, 'substantive message → model IS called');
}

// ── 4. enrichNlpOnce injection seam ──────────────────────────────────────────
{
  const store = new Map([['a', { id: 'a', content: 'Met Carol at OpenAI', nlp_processed: 2 }]]);
  const messages = {
    async selectPendingEnrichment() { return []; },
    async updateEnrichment() {},
    async selectPendingNlp() { return [...store.values()].filter((r) => r.nlp_processed === 2).map((r) => ({ id: r.id, content: r.content })); },
    async updateNlp(id, _u, f) { const r = store.get(id); Object.assign(r, { entities: f.entities, tags: f.tags, entity_summary: f.entitySummary, nlp_processed: f.nlpProcessed }); },
  };
  const svc = createEnrichmentService({ messages, embed: { embed: async () => [] }, getMasterKey: async () => 'k', classify: async () => ({}) });
  const enrich = createMessageEnricher({ infer: async () => '{"people":["Carol"],"orgs":["OpenAI"],"topics":["ai"],"gist":"met carol"}', model: 'qwen3.5:4b' });
  const res = await svc.enrichNlpOnce({ userId: 'u', enrich });
  ok(res.enriched === 1, 'enrichNlpOnce uses the injected enricher');
  ok(/Carol/.test(store.get('a').entities), 'injected enrichment wrote semantic entities');
  // no override → falls back to regex extract (deterministic)
  store.get('a').nlp_processed = 2;
  const res2 = await svc.enrichNlpOnce({ userId: 'u' });
  ok(res2.enriched === 1, 'enrichNlpOnce falls back to regex extract when no enricher injected');
}

// ── 5. task registration + model resolver ────────────────────────────────────
ok(INFERENCE_TASKS.includes('enrich'), "'enrich' is a first-class inference task");
ok((await defaultEnrichModel({ users: { getSettings: async () => ({ taskModels: { enrich: { model: 'gemma4:12b' } } }) } }, 'u')) === 'gemma4:12b', 'enrich model honors settings override');
ok((await defaultEnrichModel({ users: { getSettings: async () => ({}) } }, 'u')) === DEFAULT_LABEL_MODEL, 'enrich model defaults to the small local model');

console.log(`\n${pass} pass · ${fail} fail`);
if (fail === 0) { console.log('VERDICT: GO — L2 hybrid enrichment: prompt+parser, regex+semantic merge, graceful degrade, injection seam, task+resolver'); process.exit(0); }
console.log('VERDICT: NO-GO'); process.exit(1);
