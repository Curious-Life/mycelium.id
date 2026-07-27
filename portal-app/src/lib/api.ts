/**
 * Client-side API module — same-origin requests with HttpOnly cookie auth.
 * The portal is served by the agent-server, so all API calls are same-origin.
 *
 * When the encrypted portal channel is configured (VITE_VPS_NOISE_PUB set),
 * sensitive endpoints are automatically routed through the encrypted WebSocket
 * channel instead of plain HTTPS. See secure-fetch.ts for the routing logic.
 */

import { isSecureChannelConfigured } from './vps-identity';

const SECURE_CHANNEL = isSecureChannelConfigured();

// ── Request deadlines (QA9, operator 2026-07-27) ─────────────────────────────
// `fetch` has NO default timeout. Before this, a request that never settled left its caller
// waiting forever — and every rail surface clears its `loading` flag only in a `finally`, so a
// hung read rendered "Loading…" indefinitely with no error, no retry and no way to tell a slow
// vault from a dead one. That is what the operator saw: "refresh analysis and measurement health
// … got stuck in loading" (MeasurementHealthSection.svelte:24-39, MeasureControl.svelte:22-28,
// NarrateControl.svelte:52-53).
//
// A deadline is not a fix for slowness — it is what makes "I don't know yet" REPRESENTABLE. An
// un-timed spinner asserts "still working" on no evidence, which is the same
// inference-as-evidence class this sprint exists to remove.
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Opt out (uploads, long imports): `api(path, { timeoutMs: NO_TIMEOUT })`. */
export const NO_TIMEOUT = 0;

/** Thrown when a request passes its deadline. Distinguishable so a caller can say "taking longer
 *  than usual — retry?" instead of the generic failure copy. */
export class ApiTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(path: string, timeoutMs: number) {
    super(`Request to ${path} exceeded ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'ApiTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** True when `e` is a deadline expiry rather than a transport/HTTP failure. */
export const isTimeout = (e: unknown): e is ApiTimeoutError => e instanceof ApiTimeoutError;

// Compose a caller's signal with a deadline. Written by hand rather than with AbortSignal.any()
// so it works on every engine the app ships into (Tauri's WKWebView included) — a compat surprise
// here would silently disable every deadline below.
function deadline(caller: AbortSignal | null | undefined, ms: number) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort((caller as AbortSignal).reason);
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener('abort', onAbort, { once: true });
  }
  const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, ms);
  return {
    signal: ctrl.signal,
    didTimeOut: () => timedOut,
    // ALWAYS call this: an uncleared timer keeps a handle alive per request, and a stale abort
    // listener on a long-lived caller signal is a leak that grows with every poll tick.
    release: () => { clearTimeout(t); caller?.removeEventListener('abort', onAbort); },
  };
}

/** RequestInit + our deadline knob. */
export type ApiInit = RequestInit & { timeoutMs?: number };

// Lazy import to avoid loading crypto code when channel is disabled
let _secureApi: typeof import('./secure-fetch').secureApi | null = null;
let _isSensitivePath: typeof import('./secure-fetch').isSensitivePath | null = null;

async function getSecureModules() {
	if (!_secureApi) {
		const mod = await import('./secure-fetch');
		_secureApi = mod.secureApi;
		_isSensitivePath = mod.isSensitivePath;
	}
	return { secureApi: _secureApi!, isSensitivePath: _isSensitivePath! };
}

/**
 * Make an authenticated request to the agent-server.
 * The session cookie is sent automatically (same origin, credentials: 'same-origin').
 * On 401, redirects to /login.
 *
 * If the encrypted portal channel is configured and the path is sensitive,
 * routes through the encrypted WebSocket channel instead of plain HTTPS.
 */
export async function api(path: string, options: ApiInit = {}): Promise<Response> {
	// Local V1: the canonical portal targets the cloud product's `/portal/*`
	// endpoints; the self-hosted server serves equivalents under
	// `/api/v1/portal/*` (see src/portal-compat.js). Rewrite here so individual
	// screens need no edits. `/api/*` and `/auth/*` calls pass through unchanged.
	if (path.startsWith('/portal/')) path = '/api/v1' + path;

	// Encrypted channel routing (Phase 1) — route sensitive paths through WS
	if (SECURE_CHANNEL) {
		const { secureApi, isSensitivePath } = await getSecureModules();
		if (isSensitivePath(path)) {
			return secureApi(path, options);
		}
	}

	// Plain HTTPS path (non-sensitive endpoints, or channel not configured)
	const headers = new Headers(options.headers);

	// Don't set Content-Type for FormData (browser sets boundary)
	if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	// Send browser timezone so the server can auto-detect location
	try { headers.set('X-Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch { /* */ }

	// CSRF double-submit: read token from cookie, send as header
	const csrfMatch = document.cookie.match(/mycelium_csrf=([^;]+)/);
	if (csrfMatch) headers.set('X-CSRF-Token', csrfMatch[1]);

	// A FormData body is an UPLOAD (import archives, voice samples, attachments) and can
	// legitimately run for many minutes — a 30s deadline there would break importing a vault,
	// which is far worse than the spinner this fixes. Uploads default to no deadline; every
	// other request gets one. An explicit `timeoutMs` always wins, including NO_TIMEOUT.
	const timeoutMs = options.timeoutMs ?? (options.body instanceof FormData ? NO_TIMEOUT : DEFAULT_TIMEOUT_MS);

	let res: Response;
	if (timeoutMs > 0) {
		const d = deadline(options.signal, timeoutMs);
		try {
			res = await fetch(path, { ...options, headers, credentials: 'same-origin', signal: d.signal });
		} catch (e) {
			// Only OUR deadline becomes ApiTimeoutError. A caller-initiated abort (component
			// teardown, a superseded poll) must keep its own AbortError so existing
			// `if (e.name === 'AbortError') return;` teardown paths still behave as before.
			if (d.didTimeOut()) throw new ApiTimeoutError(path, timeoutMs);
			throw e;
		} finally {
			d.release();
		}
	} else {
		res = await fetch(path, { ...options, headers, credentials: 'same-origin' });
	}

	if (res.status === 401) {
		window.location.href = '/login';
		throw new Error('Session expired');
	}

	return res;
}

// --- Typed helpers ---

// Surface the server's JSON {error} message (these routes fail with a useful
// reason, e.g. "Instance not reachable") instead of a bare "failed (400)".
// Falls back to the generic status line for non-JSON / bodyless errors.
async function failMessage(res: Response, fallback: string): Promise<string> {
	try {
		const b = await res.clone().json();
		if (b && typeof b.error === 'string' && b.error.trim()) return b.error;
	} catch { /* non-JSON body — use the fallback */ }
	return `${fallback} (${res.status})`;
}

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
	const qs = params ? '?' + new URLSearchParams(params).toString() : '';
	const res = await api(`${path}${qs}`);
	if (!res.ok) throw new Error(await failMessage(res, `GET ${path} failed`));
	return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
	const res = await api(path, {
		method: 'POST',
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(await failMessage(res, `POST ${path} failed`));
	return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
	const res = await api(path, {
		method: 'PUT',
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(await failMessage(res, `PUT ${path} failed`));
	return res.json();
}

export async function apiDelete<T = { ok: true }>(path: string): Promise<T> {
	const res = await api(path, { method: 'DELETE' });
	if (!res.ok) throw new Error(await failMessage(res, `DELETE ${path} failed`));
	return res.json();
}

export async function apiPostForm<T>(path: string, formData: FormData): Promise<T> {
	const res = await api(path, {
		method: 'POST',
		body: formData,
	});
	if (!res.ok) throw new Error(await failMessage(res, `POST ${path} failed`));
	return res.json();
}
