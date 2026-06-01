// D7 enrichment — deterministic NLP entity/tag extraction (the rules pass).
//
// The second stage of enrichment (state machine: 0 unprocessed → 2 embedded →
// 1 enriched, per reference/server-routes/portal-enrichment.js:83). This pass
// takes an embedded message's plaintext and derives structured signals with
// pure, deterministic rules — no model, no network, fully Tier-1 verifiable.
// A model-backed pass (local Ollama / Claude CLI, as the canonical
// describe-clusters.js uses) can later replace extract() behind this same seam.
//
// Output contract (matches the canonical aggregator describe-clusters.js:174):
//   entities       {category: string[]}  — JSON.stringify → messages.entities
//   tags           string[]              — JSON.stringify → messages.tags
//   entitySummary  string                — one decrypted line → entity_summary
//
// All three land in ENCRYPTED_FIELDS.messages, so the db adapter encrypts them
// on write — this module only produces plaintext structures, never persists.

import { tokenizeStrings } from '../search/index.js';

// Bounded, backtracking-safe patterns (no nested unbounded quantifiers).
const URL_RE = /\bhttps?:\/\/[^\s<>()]{1,300}/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g;
const MENTION_RE = /(?:^|[\s(])@([A-Za-z0-9_]{2,30})\b/g;
const HASHTAG_RE = /(?:^|[\s(])#([A-Za-z0-9_]{1,40})\b/g;
const MONEY_RE = /(?:[$€£]\s?\d[\d,]{0,15}(?:\.\d{1,2})?|\b\d[\d,]{0,15}(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|CHF)\b)/gi;
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\.?\s+\d{1,2}(?:,?\s+\d{4})?)\b/g;
// Proper nouns: 2+ Capitalized words in a row ("New York", "Jane Q Smith").
// Single capitalized words are intentionally excluded — every sentence start
// is one, so they're noise for a deterministic pass.
const PROPER_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]{0,20}){1,3}\b/g;

const MAX_PER_CATEGORY = 12;
const MAX_TAGS = 8;
const MAX_SUMMARY = 240;

/** Deduped, order-preserving matches of `re` (optionally a capture group), capped. */
function collect(text, re, group = 0) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(re)) {
    const raw = (group ? m[group] : m[0]).trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= MAX_PER_CATEGORY) break;
  }
  return out;
}

/** Top-N content keywords by frequency (stopword-dropped via the search tokenizer). */
function keywordTags(text) {
  const freq = new Map();
  for (const tok of tokenizeStrings(text)) {
    if (tok.length < 3) continue;        // drop very short tokens
    if (/^\d+$/.test(tok)) continue;     // drop bare numbers
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || 0)    // freq desc; Map preserves first-seen order for ties
    .map(([t]) => t);
}

/**
 * Extract deterministic entities + tags + a summary line from plaintext.
 * Pure — same input always yields the same output. Never throws on normal
 * strings; tolerates empty/whitespace input (returns empty structures).
 *
 * @param {string} text
 * @returns {{entities: Record<string,string[]>, tags: string[], entitySummary: string}}
 */
export function extract(text) {
  const src = typeof text === 'string' ? text : '';
  if (!src.trim()) return { entities: {}, tags: [], entitySummary: '' };

  const hashtags = collect(src, HASHTAG_RE, 1).map((h) => h.toLowerCase());

  const categories = {
    url: collect(src, URL_RE),
    email: collect(src, EMAIL_RE),
    mention: collect(src, MENTION_RE, 1),
    money: collect(src, MONEY_RE),
    date: collect(src, DATE_RE),
    proper: collect(src, PROPER_RE),
    hashtag: hashtags,
  };
  // Only keep non-empty categories (matches the canonical {cat:[...]} shape).
  const entities = {};
  for (const [cat, vals] of Object.entries(categories)) {
    if (vals.length) entities[cat] = vals;
  }

  // tags = explicit hashtags first (user intent), then keyword fill, deduped.
  const tags = [];
  const seenTag = new Set();
  for (const t of [...hashtags, ...keywordTags(src)]) {
    if (seenTag.has(t)) continue;
    seenTag.add(t);
    tags.push(t);
    if (tags.length >= MAX_TAGS) break;
  }

  // entity_summary: compact "cat: v1, v2 · cat: …" line, capped.
  const parts = [];
  for (const [cat, vals] of Object.entries(entities)) {
    parts.push(`${cat}: ${vals.slice(0, 4).join(', ')}`);
  }
  let entitySummary = parts.join(' · ');
  if (entitySummary.length > MAX_SUMMARY) entitySummary = entitySummary.slice(0, MAX_SUMMARY - 1) + '…';

  return { entities, tags, entitySummary };
}

export default extract;
