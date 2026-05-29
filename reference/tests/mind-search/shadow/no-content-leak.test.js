/**
 * shadow.js — content-leak safety test.
 *
 * Per CLAUDE.md §1, the shadow comparator must NEVER log:
 *   • query text
 *   • document content / snippets / titles
 *   • token streams
 *   • vector values
 *
 * This test runs the shadow path with backends that carry distinctive
 * content markers, captures every log line emitted, and grep-asserts
 * that none of those markers appear in any captured log payload.
 *
 * Markers chosen to be unlikely to appear by accident anywhere else
 * (encryption envelopes, error classes, test fixtures), so any hit is
 * a real leak.
 *
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runShadow,
  compareToShadow,
} from '@mycelium/core/mind-search/shadow.js';

// ── Distinctive content markers ─────────────────────────────────────────

const QUERY_MARKER = 'sentinel-q-marker-3F89A1B7C2';
const DOC_CONTENT_MARKER = 'sentinel-doc-content-D7E5C4A9F2';
const DOC_TITLE_MARKER = 'sentinel-title-B6F1E3A8D4';
const VECTOR_MARKER = 0.7137519283;  // a distinctive float
const TOKEN_MARKER = 'sentinel_tok_5A2B7C9E';

function leakyHits(...ids) {
  return ids.map((id, i) => ({
    id,
    score: 1 - i * 0.1,
    // These fields would NEVER appear in real result hits — they're
    // here to make sure that if a future change accidentally serializes
    // the whole hit object into a log, the test catches it.
    content: DOC_CONTENT_MARKER + ' ' + id,
    title: DOC_TITLE_MARKER,
    embedding: [VECTOR_MARKER, 0.1, 0.2, 0.3],
    tokens: [TOKEN_MARKER, 'foo', 'bar'],
  }));
}

function fakeBackend({ hits, takenMs = 10 }) {
  return {
    async query(_q) {
      return { hits, tier: 1, takenMs };
    },
  };
}

function captureLogger() {
  const events = [];
  const logger = {
    child: () => logger,
    debug: (rec) => events.push({ level: 'debug', ...rec }),
    info:  (rec) => events.push({ level: 'info',  ...rec }),
    warn:  (rec) => events.push({ level: 'warn',  ...rec }),
    error: (rec) => events.push({ level: 'error', ...rec }),
  };
  logger.events = events;
  /** Serialize all events to a single string for grep checks. */
  logger.dump = () => JSON.stringify(events);
  return logger;
}

function assertNoLeak(dump, label) {
  const offenders = [
    QUERY_MARKER,
    DOC_CONTENT_MARKER,
    DOC_TITLE_MARKER,
    String(VECTOR_MARKER),
    TOKEN_MARKER,
  ];
  for (const marker of offenders) {
    assert.ok(
      !dump.includes(marker),
      `[${label}] log dump contains forbidden marker "${marker}"\n  dump: ${dump}`,
    );
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('shadow.js — no content leakage in logs', () => {
  it('runShadow: query text never appears in log dump', async () => {
    const logger = captureLogger();
    await runShadow(
      { text: QUERY_MARKER, topK: 5 },
      {
        primary: fakeBackend({ hits: leakyHits('a', 'b', 'c') }),
        shadow:  fakeBackend({ hits: leakyHits('a', 'b', 'd') }),
        logger,
      },
    );
    assertNoLeak(logger.dump(), 'runShadow.query-text');
  });

  it('runShadow: hit content/title/embedding/tokens never appear in log dump', async () => {
    const logger = captureLogger();
    await runShadow(
      { text: 'plain', topK: 5 },
      {
        primary: fakeBackend({ hits: leakyHits('a', 'b', 'c') }),
        shadow:  fakeBackend({ hits: leakyHits('a', 'd', 'e') }),
        logger,
      },
    );
    assertNoLeak(logger.dump(), 'runShadow.hit-fields');
  });

  it('compareToShadow: hit content fields never appear', async () => {
    const logger = captureLogger();
    const primaryResult = {
      hits: leakyHits('a', 'b', 'c'),
      tier: 1,
      takenMs: 50,
    };
    await compareToShadow(
      { text: QUERY_MARKER },
      primaryResult,
      {
        shadow: fakeBackend({ hits: leakyHits('a', 'd') }),
        logger,
      },
    );
    assertNoLeak(logger.dump(), 'compareToShadow');
  });

  it('shadow error path: error events do not include query text or content', async () => {
    const logger = captureLogger();
    const err = new Error(`error referencing the query: ${QUERY_MARKER}`);
    err.class = 'embed_down';
    await compareToShadow(
      { text: QUERY_MARKER },
      { hits: leakyHits('a') },
      {
        shadow: { async query() { throw err; } },
        logger,
      },
    );
    // The error class IS logged (that's safe). The error message
    // (containing the query marker) is NOT.
    const dump = logger.dump();
    assert.ok(dump.includes('embed_down'), 'error class should be logged');
    assertNoLeak(dump, 'compareToShadow.error-path');
  });

  it('mind_search.shadow.compare event payload is content-free by inspection', async () => {
    // Direct inspection: check the event record's fields are exclusively
    // numeric / null / known-safe scalars. Any field that's a string
    // longer than ~20 chars is flagged for review.
    const logger = captureLogger();
    await runShadow(
      { text: QUERY_MARKER },
      {
        primary: fakeBackend({ hits: leakyHits('a', 'b', 'c') }),
        shadow:  fakeBackend({ hits: leakyHits('a', 'd') }),
        logger,
      },
    );
    const compareEvents = logger.events.filter((e) => e.evt === 'mind_search.shadow.compare');
    assert.equal(compareEvents.length, 1);
    const evt = compareEvents[0];
    for (const [key, val] of Object.entries(evt)) {
      // Allowed types per the design contract: number, null, boolean,
      // or short strings (event name / level / mod).
      const allowedKnownStrings = new Set(['evt', 'mod', 'level']);
      if (typeof val === 'string' && !allowedKnownStrings.has(key)) {
        assert.ok(val.length <= 30, `field "${key}" is suspiciously long: "${val}"`);
      }
    }
  });
});
