/**
 * Secure Fetch — Routes sensitive portal API calls through the encrypted WebSocket channel.
 *
 * Downgrade protection: NEVER falls back to plain fetch() for sensitive endpoints.
 * If the channel is not ready, waits for it. If it can't connect, throws.
 *
 * Usage: Called from api.ts when secure channel is configured.
 */

import { getChannel } from './secure-channel';

// Endpoints that must go through the encrypted channel
const SENSITIVE_PREFIXES = [
	'/portal/chat/',
	'/portal/messages',
	'/portal/documents',
	'/portal/folders',
	'/portal/mindscape',
	'/portal/wealth/',
	'/portal/intel/',
	'/portal/profile',
	'/portal/activity/',
	'/portal/connections',
	'/portal/contexts',
	'/portal/export/',
	'/portal/search',
];

// Endpoints that stay on plain HTTPS (no user data)
const SAFE_PREFIXES = [
	'/portal/agents',
	'/portal/health',
	'/portal/attachment/', // binary blob, already encrypted at rest
	'/api/',               // auth endpoints — bootstrap only
];

export function isSensitivePath(path: string): boolean {
	return SENSITIVE_PREFIXES.some(p => path.startsWith(p));
}

/**
 * Map an HTTP path + method to a channel message type.
 * Returns null if the path can't be routed through the channel.
 */
function routeToType(method: string, path: string): string | null {
	// Strip query string
	const cleanPath = path.split('?')[0];

	// Exact matches first
	const key = `${method} ${cleanPath}`;
	const exactMap: Record<string, string> = {
		'POST /portal/chat/stream': 'chat',
		'GET /portal/chat/history': 'chat-history',
		'GET /portal/messages': 'messages',
		'GET /portal/documents': 'documents-list',
		'POST /portal/documents': 'documents-create',
		'GET /portal/mindscape': 'mindscape',
		'GET /portal/mindscape/social': 'mindscape-social',
		'GET /portal/mindscape/growth': 'mindscape-growth',
		'GET /portal/mindscape/growth/summary': 'mindscape-growth-summary',
		'GET /portal/mindscape/realms': 'mindscape-realms',
		'GET /portal/profile': 'profile',
		'PUT /portal/profile': 'profile-update',
		'GET /portal/activity/today': 'activity-today',
		'GET /portal/activity/summary': 'activity-summary',
		'GET /portal/wealth/portfolios': 'wealth-portfolios',
		'GET /portal/wealth/watchlist': 'wealth-watchlist',
		'GET /portal/wealth/assets': 'wealth-assets',
		'GET /portal/connections': 'connections',
		'GET /portal/contexts': 'contexts',
	};

	if (exactMap[key]) return exactMap[key];

	// Prefix matches for parameterized routes
	if (cleanPath.startsWith('/portal/wealth/portfolios/') && method === 'GET') {
		if (cleanPath.endsWith('/positions')) return 'wealth-positions';
		if (cleanPath.endsWith('/transactions')) return 'wealth-transactions';
		if (cleanPath.endsWith('/performance')) return 'wealth-performance';
		return 'wealth-portfolio-detail';
	}
	if (cleanPath.startsWith('/portal/mindscape/social/') && method === 'GET') return 'mindscape-social-detail';
	if (cleanPath.startsWith('/portal/intel/') && method === 'GET') return 'intel';
	if (cleanPath.startsWith('/portal/documents/') && method === 'GET') return 'document-detail';
	if (cleanPath.startsWith('/portal/documents/') && method === 'PUT') return 'document-update';

	return null;
}

/** Extract path parameters from URL patterns */
function extractParams(path: string): Record<string, string> {
	const cleanPath = path.split('?')[0];
	const params: Record<string, string> = {};

	// Extract ID from parameterized paths
	const segments = cleanPath.split('/').filter(Boolean);
	// /portal/wealth/portfolios/:id/positions → id is segments[3]
	if (segments.length >= 4 && segments[1] === 'wealth' && segments[2] === 'portfolios') {
		params.portfolioId = segments[3];
	}
	if (segments.length >= 4 && segments[1] === 'mindscape' && segments[2] === 'social') {
		params.contactId = segments[3];
	}
	if (segments.length >= 3 && segments[1] === 'documents') {
		params.documentId = segments[2];
	}

	return params;
}

/** Parse query string into key-value pairs */
function parseQuery(path: string): Record<string, string> {
	const qIdx = path.indexOf('?');
	if (qIdx === -1) return {};
	const params: Record<string, string> = {};
	for (const part of path.substring(qIdx + 1).split('&')) {
		const [k, v] = part.split('=');
		if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
	}
	return params;
}

/** Streaming message types that use requestStream instead of request */
const STREAM_TYPES = new Set(['chat']);

/**
 * Route a fetch-like call through the encrypted channel.
 *
 * @throws {Error} if channel is not available and this is a sensitive path (downgrade protection)
 */
export async function secureApi(path: string, options: RequestInit = {}): Promise<Response> {
	const method = (options.method || 'GET').toUpperCase();
	const type = routeToType(method, path);

	if (!type) {
		// Can't route through channel — this shouldn't happen for sensitive paths
		throw new Error(`No secure route for ${method} ${path}`);
	}

	const channel = getChannel();

	// Build request data
	const query = parseQuery(path);
	const pathParams = extractParams(path);
	let body: Record<string, unknown> = {};

	if (options.body) {
		try {
			body = typeof options.body === 'string'
				? JSON.parse(options.body) as Record<string, unknown>
				: (options.body as unknown) as Record<string, unknown>;
		} catch {
			body = {};
		}
	}

	const data = { ...query, ...pathParams, ...body };

	// Handle streaming types (like chat)
	if (STREAM_TYPES.has(type)) {
		// Return a fake Response with a ReadableStream that emits SSE-like events
		const stream = new ReadableStream({
			async start(controller) {
				try {
					await channel.requestStream(type, data, (chunk: unknown) => {
						const sseEvent = `data: ${JSON.stringify(chunk)}\n\n`;
						controller.enqueue(new TextEncoder().encode(sseEvent));
					});
					controller.close();
				} catch (err) {
					controller.error(err);
				}
			},
		});

		return new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' },
		});
	}

	// Regular request/response
	const result = await channel.request(type, data);
	return new Response(JSON.stringify(result), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
