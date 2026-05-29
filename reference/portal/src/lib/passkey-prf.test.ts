import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { base64urlToBytes, convertPrfSalts, stripPrfOnMobile, preparePrfOptions } from './passkey-prf.ts';

// atob/Uint8Array exist in Node 16+; no polyfill needed.

describe('base64urlToBytes', () => {
	it('decodes a 32-byte base64url salt to 32 bytes', () => {
		// 32 random bytes, base64url-encoded (no padding by convention)
		const b64url = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
		const bytes = base64urlToBytes(b64url);
		assert.equal(bytes.length, 32);
		assert.equal(bytes[0], 0x00);
		assert.equal(bytes[31], 0x1f);
	});

	it('handles base64url with - and _ characters', () => {
		// "Hello, world!" → SGVsbG8sIHdvcmxkIQ== (b64) → SGVsbG8sIHdvcmxkIQ (b64url, no padding)
		const bytes = base64urlToBytes('SGVsbG8sIHdvcmxkIQ');
		const decoded = new TextDecoder().decode(bytes);
		assert.equal(decoded, 'Hello, world!');
	});

	it('handles base64url with characters that differ from standard base64', () => {
		// Bytes with ? and > characters (b64 chars '+' and '/' must round-trip as '-' and '_' in url-safe)
		// Use bytes that encode to chars containing '+' and '/' in standard b64
		const bytes = base64urlToBytes('--__');
		assert.equal(bytes.length, 3);
		// ----  decodes to 0xfb 0xef 0xff in standard b64 → same in url-safe
		assert.equal(bytes[0], 0xfb);
		assert.equal(bytes[1], 0xef);
		assert.equal(bytes[2], 0xff);
	});

	it('handles empty string', () => {
		const bytes = base64urlToBytes('');
		assert.equal(bytes.length, 0);
	});
});

describe('convertPrfSalts — evalByCredential (authentication)', () => {
	it('decodes single-credential evalByCredential.first', () => {
		const opts = {
			extensions: {
				prf: {
					evalByCredential: {
						credA: { first: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' },
					},
				},
			},
		};
		const result = convertPrfSalts(opts);
		assert.equal(result, true);
		const ebc = (opts.extensions.prf as any).evalByCredential as Record<string, { first: Uint8Array }>;
		assert.ok(ebc.credA.first instanceof Uint8Array);
		assert.equal(ebc.credA.first.length, 32);
	});

	it('decodes multi-credential map (N credentials)', () => {
		const opts = {
			extensions: {
				prf: {
					evalByCredential: {
						credA: { first: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' },
						credB: { first: 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA' },
					},
				},
			},
		};
		convertPrfSalts(opts);
		const ebc = (opts.extensions.prf as any).evalByCredential as Record<string, { first: Uint8Array }>;
		assert.ok(ebc.credA.first instanceof Uint8Array);
		assert.ok(ebc.credB.first instanceof Uint8Array);
		assert.equal(ebc.credA.first.length, 32);
		assert.equal(ebc.credB.first.length, 32);
	});

	it('is idempotent — does not re-encode already-Uint8Array values', () => {
		const existing = new Uint8Array([1, 2, 3, 4]);
		const opts = {
			extensions: { prf: { evalByCredential: { credA: { first: existing } } } },
		};
		convertPrfSalts(opts);
		const ebc = (opts.extensions.prf as any).evalByCredential as Record<string, { first: Uint8Array }>;
		assert.equal(ebc.credA.first, existing); // same reference, no re-wrap
	});
});

describe('convertPrfSalts — eval.first (registration)', () => {
	it('decodes eval.first single salt', () => {
		const opts = {
			extensions: {
				prf: {
					eval: { first: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' },
				},
			},
		};
		const result = convertPrfSalts(opts);
		assert.equal(result, true);
		const ev = (opts.extensions.prf as any).eval as { first: Uint8Array };
		assert.ok(ev.first instanceof Uint8Array);
		assert.equal(ev.first.length, 32);
	});
});

describe('convertPrfSalts — degenerate inputs', () => {
	it('returns false on options without extensions', () => {
		const opts: Record<string, unknown> = {};
		const result = convertPrfSalts(opts);
		assert.equal(result, false);
	});

	it('returns false on options.extensions without prf', () => {
		const opts = { extensions: { other: 'thing' } };
		const result = convertPrfSalts(opts);
		assert.equal(result, false);
	});

	it('returns false on prf with neither eval nor evalByCredential', () => {
		const opts = { extensions: { prf: { somethingElse: true } } };
		const result = convertPrfSalts(opts);
		assert.equal(result, false);
	});

	it('does not throw on null extensions', () => {
		const opts = { extensions: null };
		assert.doesNotThrow(() => convertPrfSalts(opts as any));
	});
});

describe('stripPrfOnMobile', () => {
	it('strips PRF extension on iPhone UA', () => {
		const opts: Record<string, unknown> = {
			extensions: { prf: { evalByCredential: { a: { first: 'x' } } } },
		};
		const stripped = stripPrfOnMobile(opts, 'Mozilla/5.0 (iPhone; ...)');
		assert.equal(stripped, true);
		// extensions had only `prf`, so it's deleted entirely (see "removes empty extensions" test)
		assert.equal(opts.extensions, undefined);
	});

	it('strips PRF on Android UA', () => {
		const opts = { extensions: { prf: { evalByCredential: { a: { first: 'x' } } } } };
		const stripped = stripPrfOnMobile(opts, 'Mozilla/5.0 (Linux; Android 14; Pixel)');
		assert.equal(stripped, true);
	});

	it('strips PRF on iPad UA', () => {
		const opts = { extensions: { prf: { eval: { first: 'x' } } } };
		const stripped = stripPrfOnMobile(opts, 'Mozilla/5.0 (iPad; ...)');
		assert.equal(stripped, true);
	});

	it('removes empty extensions object after PRF strip', () => {
		const opts = { extensions: { prf: { eval: { first: 'x' } } } };
		stripPrfOnMobile(opts, 'iPhone');
		assert.equal(opts.extensions, undefined);
	});

	it('preserves non-prf extensions after PRF strip', () => {
		const opts = { extensions: { prf: { eval: { first: 'x' } }, other: 'keep' } };
		stripPrfOnMobile(opts, 'iPhone');
		assert.equal((opts.extensions as any).other, 'keep');
		assert.equal((opts.extensions as any).prf, undefined);
	});

	it('does NOT strip on desktop UA (macOS)', () => {
		const opts = { extensions: { prf: { evalByCredential: { a: { first: 'x' } } } } };
		const stripped = stripPrfOnMobile(opts, 'Mozilla/5.0 (Macintosh; Intel Mac OS X)');
		assert.equal(stripped, false);
		assert.ok((opts.extensions as any).prf);
	});

	it('does NOT strip on Linux desktop UA', () => {
		const opts = { extensions: { prf: { evalByCredential: { a: { first: 'x' } } } } };
		const stripped = stripPrfOnMobile(opts, 'Mozilla/5.0 (X11; Linux x86_64)');
		assert.equal(stripped, false);
	});

	it('does not throw when no PRF present', () => {
		const opts = { extensions: { other: 'thing' } };
		const stripped = stripPrfOnMobile(opts, 'iPhone');
		assert.equal(stripped, false);
		assert.deepEqual(opts, { extensions: { other: 'thing' } });
	});
});

describe('preparePrfOptions — integration', () => {
	it('desktop path: decodes salts, returns hasPrf=true', () => {
		const opts = {
			extensions: {
				prf: { evalByCredential: { a: { first: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' } } },
			},
		};
		const { hasPrf } = preparePrfOptions(opts, 'Mozilla/5.0 (Macintosh)');
		assert.equal(hasPrf, true);
		const ebc = (opts.extensions.prf as any).evalByCredential as Record<string, { first: Uint8Array }>;
		assert.ok(ebc.a.first instanceof Uint8Array);
	});

	it('mobile path: strips PRF, returns hasPrf=false', () => {
		const opts = {
			extensions: { prf: { evalByCredential: { a: { first: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' } } } },
		};
		const { hasPrf } = preparePrfOptions(opts, 'iPhone');
		assert.equal(hasPrf, false);
		assert.equal((opts as any).extensions, undefined);
	});

	it('no-PRF path: returns hasPrf=false, no mutation', () => {
		const opts = { challenge: 'abc' };
		const { hasPrf } = preparePrfOptions(opts, 'Mozilla/5.0 (Macintosh)');
		assert.equal(hasPrf, false);
		assert.deepEqual(opts, { challenge: 'abc' });
	});
});
