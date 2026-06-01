/**
 * WebAuthn PRF (Pseudo-Random Function) extension helpers.
 *
 * The server emits PRF salts as base64url strings in
 * `options.extensions.prf.{eval,evalByCredential}.first` (see
 * `packages/core/auth/passkey.js` `generateAuthOptions`). The WebAuthn API
 * requires those values to be `ArrayBuffer`/`ArrayBufferView`. Forgetting
 * the conversion produces:
 *
 *   "Failed to read the 'first' property from 'AuthenticationExtensionsPRFValues':
 *    The provided value is not of type '(ArrayBuffer or ArrayBufferView)'."
 *
 * That was nati's blocker during the 2026-05-21 QA session — the account-deletion
 * flow at `settings/+page.svelte:902-923` and the `addPasskey()` flow at the same
 * file called `startAuthentication`/`startRegistration` directly on the raw server
 * options. Login was the only place that did the decode (as an inline helper).
 *
 * This module is the single source of truth. Every caller of
 * `startAuthentication`/`startRegistration` MUST call `preparePrfOptions` first.
 * A regression test (passkey-prf-callers.test.ts) enforces the rule at CI time.
 */

/**
 * Decode a base64url-encoded string to a `Uint8Array`.
 *
 * Tolerates missing padding. Use this for any salt/challenge bytes that came
 * from the server as JSON strings.
 */
export function base64urlToBytes(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
	const binary = atob(b64 + pad);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * In-place: decode base64url PRF salt strings to `Uint8Array` so the WebAuthn
 * API accepts them. Handles both the `evalByCredential` map (authentication)
 * and the simpler `eval.first` (registration) shapes.
 *
 * Idempotent — if `first` is already a `Uint8Array`, leaves it alone.
 *
 * @returns true if PRF was present (caller can branch on URK availability)
 */
export function convertPrfSalts(options: Record<string, unknown>): boolean {
	const ext = options.extensions as Record<string, unknown> | undefined;
	if (!ext?.prf) return false;

	const prf = ext.prf as Record<string, unknown>;

	// evalByCredential: map of credentialId → { first: base64url | Uint8Array }
	if (prf.evalByCredential) {
		const ebc = prf.evalByCredential as Record<string, { first: string | Uint8Array }>;
		for (const [credId, val] of Object.entries(ebc)) {
			if (typeof val.first === 'string') {
				ebc[credId] = { first: base64urlToBytes(val.first) };
			}
		}
		return true;
	}

	// eval.first: single salt (registration shape)
	const ev = prf.eval as Record<string, unknown> | undefined;
	if (ev && typeof ev.first === 'string') {
		ev.first = base64urlToBytes(ev.first as string);
		return true;
	}

	return false;
}

/**
 * In-place: strip the PRF extension on mobile user agents.
 *
 * 1Password iOS/Android can't handle `evalByCredential` and renders a blank
 * WebAuthn sheet (no credential offered, user is stuck). URK derivation via
 * PRF is desktop-only by design; on mobile, auth proceeds without URK and
 * the master-key fallback handles key derivation.
 *
 * @returns true if PRF was stripped (caller knows URK won't be available)
 */
export function stripPrfOnMobile(options: Record<string, unknown>, userAgent: string): boolean {
	const isMobile = /iPhone|iPad|Android/i.test(userAgent);
	if (!isMobile) return false;

	const ext = options.extensions as Record<string, unknown> | undefined;
	if (!ext?.prf) return false;

	delete ext.prf;
	if (Object.keys(ext).length === 0) delete options.extensions;
	return true;
}

/**
 * Convenience entry point. Applies both transformations:
 *   - On mobile: strip PRF entirely (avoids blank-sheet bug)
 *   - On desktop: decode base64url salts to `Uint8Array`
 *
 * Returns `{ hasPrf }` indicating whether PRF will actually run. Callers can
 * use this to decide whether to compute a URK from the result.
 *
 * @param options - WebAuthn options object from the server (mutated in place)
 * @param userAgent - defaults to `navigator.userAgent`; pass explicitly in tests
 */
export function preparePrfOptions(
	options: Record<string, unknown>,
	userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): { hasPrf: boolean } {
	const stripped = stripPrfOnMobile(options, userAgent);
	if (stripped) return { hasPrf: false };
	const decoded = convertPrfSalts(options);
	return { hasPrf: decoded };
}
