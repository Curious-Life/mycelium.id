import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard: every portal file that calls `startAuthentication` or
 * `startRegistration` (from @simplewebauthn/browser) MUST also import a PRF
 * helper from `$lib/passkey-prf` and use it on the options.
 *
 * Why this exists: the 2026-05-21 nati-blocker bug was caused by
 * `settings/+page.svelte:902-923` (account deletion) and `:594-615` (addPasskey)
 * calling `startAuthentication`/`startRegistration` directly on raw server
 * options. The server emits `extensions.prf.evalByCredential[*].first` as
 * base64url strings; WebAuthn requires `ArrayBuffer`/`ArrayBufferView`.
 * The login page had an inline `convertPrfSalts` helper; the deletion +
 * addPasskey paths skipped it. Result: WebAuthn rejection with
 * "first property is not of type '(ArrayBuffer or ArrayBufferView)'".
 *
 * After Phase 0 of ACCOUNT-DELETION-LIFECYCLE-DESIGN-2026-05-21.md, the
 * helper lives in `packages/portal/src/lib/passkey-prf.ts` and is shared.
 * This test prevents any future PR from regressing by adding a new caller
 * that forgets the import.
 *
 * Allowlist exists for the helper module itself + tests of the helper.
 */

const __filename = fileURLToPath(import.meta.url);
const PORTAL_SRC = dirname(dirname(__filename)); // packages/portal/src/lib → packages/portal/src

const ALLOWLIST = new Set([
	// The helper module itself defines the pattern; doesn't call it
	'lib/passkey-prf.ts',
	// This test file references the function names as strings
	'lib/passkey-prf-callers.test.ts',
	// Unit tests for the helper
	'lib/passkey-prf.test.ts',
]);

const WEBAUTHN_CALL_PATTERN = /\b(startAuthentication|startRegistration)\s*\(/;
const PRF_IMPORT_PATTERN = /from\s+['"](\$lib\/passkey-prf|\.\.?\/(?:lib\/)?passkey-prf)/;

async function* walkPortalFiles(dir: string, base = ''): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		const rel = base ? `${base}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			yield* walkPortalFiles(full, rel);
		} else if (entry.isFile() && /\.(ts|svelte|js)$/.test(entry.name)) {
			yield rel;
		}
	}
}

describe('passkey-prf caller audit', () => {
	it('every file that calls startAuthentication/startRegistration imports passkey-prf', async () => {
		const violations: string[] = [];
		for await (const rel of walkPortalFiles(PORTAL_SRC)) {
			if (ALLOWLIST.has(rel)) continue;
			const content = await readFile(join(PORTAL_SRC, rel), 'utf-8');
			if (!WEBAUTHN_CALL_PATTERN.test(content)) continue;
			if (!PRF_IMPORT_PATTERN.test(content)) {
				violations.push(rel);
			}
		}

		assert.deepEqual(
			violations,
			[],
			`Files calling startAuthentication/startRegistration without importing ` +
				`from $lib/passkey-prf: ${violations.join(', ')}. ` +
				`Server emits PRF salts as base64url strings; WebAuthn needs Uint8Array. ` +
				`Import preparePrfOptions from $lib/passkey-prf and call it before ` +
				`startAuthentication/startRegistration.`,
		);
	});
});
