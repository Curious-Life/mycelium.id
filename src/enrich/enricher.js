// src/enrich/enricher.js — hybrid per-message enrichment (Context Engine L2).
//
// REGEX (extract.js) is perfect at structured entities (url/email/money/date/hashtag/mention)
// and an LLM would do them WORSE; the local small model (qwen3.5:4b) adds what regex can't —
// named people / orgs / places, semantic topics, and a one-line gist. This merges both into the
// SAME { entities, tags, entitySummary } shape that updateNlp + search + describeEntity already
// consume, so nothing downstream changes.
//
// Robustness: a model outage OR a garbled reply both DEGRADE to regex-only output (the row still
// enriches, just without the semantic layer) — never a throw, never a stall. This matters because
// the old behavior was always-regex; a model-less host (no Ollama) must keep getting regex
// enrichment, not freeze. The only cost: a message enriched during a brief outage gets regex-only
// until it's re-enriched. (The daemon is woken before this runs, so outages here are rare.)
import { extract } from './extract.js';
import { buildEnrichPrompt, parseEnrichResponse } from './enrich-prompt.js';

const MAX_PER_CATEGORY = 12;
const MAX_TAGS = 12;
const MAX_SUMMARY = 240;

function dedupeCap(values, cap) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * @param {object} o
 * @param {(prompt:string)=>Promise<string>} o.infer  text completion; THROWS on transport outage.
 * @param {string} [o.model]  model label for provenance, exposed as `.model`.
 * @returns {((content:string)=>Promise<{entities:object, tags:string[], entitySummary:string}>) & {model?:string}}
 */
export function createMessageEnricher({ infer, model } = {}) {
  if (typeof infer !== 'function') throw new TypeError('createMessageEnricher: infer(prompt) required');
  async function enrich(content) {
    const base = extract(content); // structured entities + keyword tags + compact summary (regex)
    const trimmed = String(content || '').trim();
    if (!trimmed) return base;
    // Skip the model on trivial / low-information messages — small models HALLUCINATE entities
    // on contentless input (live smoke: "hi beings" → person:[beings]) and it wastes a call.
    // Regex base is the right output for these. Threshold: very short OR very few words.
    if (trimmed.length < 40 || trimmed.split(/\s+/).length < 6) return base;

    let sem;
    try { sem = parseEnrichResponse(await infer(buildEnrichPrompt(content))); }
    catch { return base; } // model down / transport → degrade to regex-only (never stall a row)
    const entities = { ...base.entities };
    const add = (cat, vals) => { if (vals.length) entities[cat] = dedupeCap([...(entities[cat] || []), ...vals], MAX_PER_CATEGORY); };
    add('person', sem.people);
    add('org', sem.orgs);
    add('place', sem.places);

    // topics enrich the keyword tags (lowercased, deduped, regex tags lead — they carry user #intent).
    const tags = dedupeCap([...base.tags, ...sem.topics.map((t) => t.toLowerCase())], MAX_TAGS);

    // The model's gist leads the summary (a real sentence), then the regex structured line.
    let entitySummary = sem.gist
      ? (base.entitySummary ? `${sem.gist} · ${base.entitySummary}` : sem.gist)
      : base.entitySummary;
    if (entitySummary.length > MAX_SUMMARY) entitySummary = entitySummary.slice(0, MAX_SUMMARY - 1) + '…';

    return { entities, tags, entitySummary };
  }
  enrich.model = model;
  return enrich;
}

export default createMessageEnricher;
