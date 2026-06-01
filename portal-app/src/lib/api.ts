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

export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
	const qs = params ? '?' + new URLSearchParams(params).toString() : '';
	const res = await api(`${path}${qs}`);
	if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
	return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
	const res = await api(path, {
		method: 'POST',
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`POST ${path} failed (${res.status})`);
	return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
	const res = await api(path, {
		method: 'PUT',
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`PUT ${path} failed (${res.status})`);
	return res.json();
}

export async function apiDelete<T = { ok: true }>(path: string): Promise<T> {
	const res = await api(path, { method: 'DELETE' });
	if (!res.ok) throw new Error(`DELETE ${path} failed (${res.status})`);
	return res.json();
}

export async function apiPostForm<T>(path: string, formData: FormData): Promise<T> {
	const res = await api(path, {
		method: 'POST',
		body: formData,
	});
	if (!res.ok) throw new Error(`POST ${path} failed (${res.status})`);
	return res.json();
}
