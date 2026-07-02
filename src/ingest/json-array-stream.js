// Incremental JSON-array streamer — yields the top-level elements of a JSON
// array one at a time, from a Readable, in CONSTANT memory.
//
// Why: AI exports (Claude/ChatGPT conversations.json) are routinely multi-GB.
// Reading the whole file into one JS string is impossible past V8's hard
// 512 MB string cap (buffer.constants.MAX_STRING_LENGTH = 536,870,888), and a
// full JSON.parse holds the entire array in the heap. This streams the array
// element-by-element so the file is never one string and only ONE element
// (one conversation) is live at a time.
//
// Backpressure: the source is paused while the consumer (an async DB write per
// element) is working, so the parser can't race ahead and buffer the whole file.
//
// Security: runs on attacker-influenceable input. Per-element size is bounded by
// the caller's byte cap on the source stream (see zip-stream.js); a malformed
// document rejects via onError (never a raw throw mid-pipe).
import { JSONParser } from '@streamparser/json';

const HIGH_WATER_ELEMENTS = 8; // pause the source once this many parsed elements are queued

/**
 * Yield each top-level element of a JSON array read from `readable`.
 * @param {import('node:stream').Readable} readable  decompressed conversations.json bytes
 * @param {{ path?: string }} [opts]  JSONPath of elements to emit (default top-level array items)
 * @returns {AsyncGenerator<any>}
 */
export async function* streamJsonArray(readable, { path = '$.*' } = {}) {
  const parser = new JSONParser({ paths: [path], keepStack: false });
  const queue = [];
  let wake = null;
  let ended = false;
  let error = null;

  const signal = () => { if (wake) { const w = wake; wake = null; w(); } };

  parser.onValue = (info) => {
    queue.push(info.value);
    if (queue.length >= HIGH_WATER_ELEMENTS && !readable.isPaused()) readable.pause();
    signal();
  };
  parser.onError = (e) => { error = error || e; signal(); };

  readable.on('data', (chunk) => {
    if (error) return;
    try { parser.write(chunk); } catch (e) { error = error || e; signal(); }
  });
  // The array's closing `]` auto-ends the parser; only call end() if it hasn't
  // (i.e. the stream ended mid-document → truncated input → a real error).
  readable.on('end', () => { try { if (!parser.isEnded) parser.end(); } catch (e) { error = error || e; } ended = true; signal(); });
  readable.on('error', (e) => { error = error || e; ended = true; signal(); });

  while (true) {
    if (error) throw error;
    if (queue.length) {
      const v = queue.shift();
      if (queue.length < HIGH_WATER_ELEMENTS && readable.isPaused()) readable.resume();
      yield v;
      continue;
    }
    if (ended) { if (error) throw error; return; }
    await new Promise((res) => { wake = res; });
  }
}

export default streamJsonArray;
