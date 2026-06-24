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
export async function api(path: string, options: RequestInit = {}): Promise<Response> {
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

	const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });

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
