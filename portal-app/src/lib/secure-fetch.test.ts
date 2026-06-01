/**
 * Tests for secure-fetch.ts — the routing layer that decides which
 * portal API calls flow through the Noise NK channel vs plain HTTPS.
 *
 * These are the invariants PR1a locks in. Future PRs (1b/1c) extend
 * the allowlist but must NOT regress these.
 *
 * Run: vitest run packages/portal/src/lib/secure-fetch.test.ts
 */

import { describe, it, expect } from 'vitest';
import { isSensitivePath } from './secure-fetch';

describe('isSensitivePath — critical-leak prefixes (PR1a)', () => {
	// Each pair: [path, expected isSensitive]
	const cases: Array<[string, boolean]> = [
		// Baseline (Phase 1 v1) — must remain sensitive
		['/portal/chat/stream', true],
		['/portal/chat/history', true],
		['/portal/messages', true],
		['/portal/messages?limit=50', true],
		['/portal/documents', true],
		['/portal/documents/abc', true],
		['/portal/mindscape', true],
		['/portal/mindscape/social', true],
		['/portal/mindscape/cofire?territory=x', true],
		['/portal/wealth/portfolios', true],
		['/portal/intel/recommendations', true],
		['/portal/profile', true],
		['/portal/activity/today', true],
		['/portal/connections', true],
		['/portal/connections/count', true],
		['/portal/contexts', true],
		['/portal/export/auth', true],
		['/portal/export/verify', true],
		['/portal/search', true],
		['/portal/vitality/snapshot', true],

		// PR1a additions — these were leaking before
		['/portal/settings/secret', true],
		['/portal/settings/secrets', true],
		['/portal/passkeys', true],
		['/portal/passkeys/abc', true],
		['/portal/passkeys/register/options', true],
		['/portal/master-key/restore', true],
		['/portal/delete-account', true],
		['/portal/delete-account/auth', true],
		['/portal/delete-account/verify', true],
		['/portal/health/today', true],
		['/portal/health/range', true],
		['/portal/health/range?from=2026-01-01&to=2026-05-01', true],
		['/portal/health/summary', true],
		['/portal/health/sync', true],
		['/portal/import/messages', true],
		['/portal/import/documents', true],
		['/portal/import/vault', true],
		['/portal/billing', true],
		['/portal/billing/portal', true],
		['/portal/billing/crypto', true],
		['/portal/providers', true],
		['/portal/providers/openai', true],
		['/portal/stats', true],
		['/portal/audit/log', true],
		['/portal/energy', true],
		['/portal/energy/summary', true],
		['/portal/onboarding/status', true],
		['/portal/integrations/linear', true],
		['/portal/metric-freshness', true],
		['/portal/pipeline/status', true],
		['/portal/telegram/groups', true],
		['/portal/auth/claude', true],
		['/portal/auth/claude/status', true],
		['/portal/auth/openai', true],

		// Intentional plain-HTTPS routes — must remain non-sensitive
		['/portal/health', false],                       // bare liveness check (sensitive list has /portal/health/ with slash)
		['/portal/agents', false],                       // public agent metadata, cacheable
		['/portal/attachment/abc', false],               // binary R2 proxy (PR1c)
		['/portal/upload/chunk', false],                 // FormData (PR1c)
		['/portal/upload/complete', false],
		['/portal/send-file', false],
		['/portal/master-key/rotate', false],            // SSE (PR1c) — distinct from /restore which IS sensitive
		// /portal/mindscape/explore/stream/:jobId is accessed via EventSource (NOT api()/fetch),
		// so its isSensitivePath value is irrelevant operationally. It DOES match
		// /portal/mindscape prefix → true; documenting the assertion truthfully:
		['/portal/mindscape/explore/stream/abc', true],
		['/portal/sse/document', false],                 // Not in any SENSITIVE prefix; accessed via EventSource
		['/portal/sse/library', false],                  // Same
		['/portal/auth/channel/methods', false],         // pre-session
		['/portal/auth/channel/telegram-widget', false], // pre-session
		['/portal/auth/channel/telegram-widget/start', false],
		['/portal/fleet/gate', false],                   // PR1b
		['/api/login/passkey-options', false],
		['/api/login/passkey-verify', false],
	];

	for (const [path, expected] of cases) {
		it(`isSensitivePath('${path}') === ${expected}`, () => {
			expect(isSensitivePath(path)).toBe(expected);
		});
	}
});

describe('isSensitivePath — prefix boundaries (no false matches)', () => {
	// String.startsWith semantics — ensure we don't accidentally
	// match by lexical similarity.
	it('does not match /portal/healthy (made-up path)', () => {
		// /portal/health/ has trailing slash so /portal/healthy doesn't match
		expect(isSensitivePath('/portal/healthy')).toBe(false);
	});

	it('matches /portal/health/anything (with slash)', () => {
		expect(isSensitivePath('/portal/health/something')).toBe(true);
	});

	it('does not collide /portal/auth/claude vs /portal/auth/channel', () => {
		expect(isSensitivePath('/portal/auth/claude')).toBe(true);
		expect(isSensitivePath('/portal/auth/claude/status')).toBe(true);
		expect(isSensitivePath('/portal/auth/claude/disconnect')).toBe(true);
		// Characters diverge at index 18 (e vs i), so startsWith is false:
		expect(isSensitivePath('/portal/auth/claudia')).toBe(false);
		expect(isSensitivePath('/portal/auth/channel/methods')).toBe(false);
	});

	it('does not match /api/ (different namespace)', () => {
		expect(isSensitivePath('/api/login/passkey-options')).toBe(false);
		expect(isSensitivePath('/api/anything')).toBe(false);
	});
});

describe('isSensitivePath — regression guard for SSE / FormData routes (PR1c)', () => {
	// Routes deliberately kept on plain HTTPS in PR1a because they
	// need stream-type or chunked-binary handler support before they
	// can route through the channel. If a future PR adds them to
	// SENSITIVE_PREFIXES without also adding the stream/binary handler,
	// the routes will hang or throw. These assertions prevent that
	// regression until PR1c.

	it('master-key/rotate stays raw (SSE) — distinct from master-key/restore', () => {
		expect(isSensitivePath('/portal/master-key/restore')).toBe(true);  // sensitive
		expect(isSensitivePath('/portal/master-key/rotate')).toBe(false);  // SSE, raw until PR1c
	});

	it('attachment binary proxy stays raw', () => {
		expect(isSensitivePath('/portal/attachment/abc-123-def')).toBe(false);
	});

	it('chunked-upload FormData stays raw', () => {
		expect(isSensitivePath('/portal/upload/chunk')).toBe(false);
		expect(isSensitivePath('/portal/upload/complete')).toBe(false);
		expect(isSensitivePath('/portal/send-file')).toBe(false);
	});
});
