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
		'POST /portal/wealth/portfolios': 'wealth-create-portfolio',
		'GET /portal/wealth/watchlist': 'wealth-watchlist',
		'GET /portal/wealth/assets': 'wealth-assets',
		'GET /portal/connections': 'connections',
		'POST /portal/connections/request': 'connection-request',
		'GET /portal/connections/count': 'connections-count',
		'GET /portal/connections/pending': 'connections-pending',
		'GET /portal/contexts': 'contexts',
		'POST /portal/contexts': 'context-create',
		'GET /portal/folders': 'folders',
		'POST /portal/folders': 'folder-create',
		'GET /portal/attachments': 'attachments',
		'GET /portal/activity/range': 'activity-range',
		'GET /portal/activity/apps': 'activity-apps',
		'GET /portal/activity/messages': 'activity-messages',
		'POST /portal/activity/sync': 'activity-sync',
		'POST /portal/documents/move': 'documents-move',
		'POST /portal/documents/pin': 'documents-pin',
		'GET /portal/mindscape/territories': 'mindscape-territories',
		'GET /portal/mindscape/activations': 'mindscape-activations',
		'GET /portal/mindscape/cofire': 'mindscape-cofire',
		'GET /portal/mindscape/noise-stats': 'mindscape-noise-stats',
		'GET /portal/health/today': 'health-today',
		'GET /portal/health/range': 'health-range',
		'GET /portal/health/summary': 'health-summary',
		'POST /portal/health/sync': 'health-sync',
		'GET /portal/intel/report': 'intel-report',
		'GET /portal/intel/recommendations': 'intel-recommendations',
		'GET /portal/intel/signals': 'intel-signals',
		'GET /portal/intel/entities': 'intel-entities',
		'GET /portal/settings': 'settings',
		'PUT /portal/settings': 'settings-update',
		'GET /portal/stats': 'stats',
		'GET /portal/billing': 'billing',
		'POST /portal/billing/portal': 'billing-portal',
		'POST /portal/billing/crypto': 'billing-crypto',
		'GET /portal/providers': 'providers',
		'POST /portal/providers': 'provider-create',
		'POST /portal/profile/stats/recompute': 'profile-recompute',
		'POST /portal/export/auth': 'export-auth',
		'POST /portal/export/verify': 'export-verify',
		'POST /portal/export': 'export',
		'POST /portal/import/vault': 'import-vault',
		'POST /portal/import/messages': 'import-messages',
		'POST /portal/import/documents': 'import-documents',
		'POST /portal/auth/claude': 'auth-claude',
		'POST /portal/auth/claude/code': 'auth-claude-code',
		'GET /portal/auth/claude/status': 'auth-claude-status',
		'POST /portal/auth/claude/disconnect': 'auth-claude-disconnect',
	};

	if (exactMap[key]) return exactMap[key];

	// Prefix matches for parameterized routes
	// Wealth parameterized routes
	if (cleanPath.startsWith('/portal/wealth/portfolios/')) {
		if (method === 'DELETE') return 'wealth-delete-portfolio';
		if (cleanPath.endsWith('/positions')) return 'wealth-positions';
		if (cleanPath.endsWith('/transactions') && method === 'GET') return 'wealth-transactions';
		if (cleanPath.endsWith('/transactions') && method === 'POST') return 'wealth-add-transaction';
		if (cleanPath.endsWith('/performance')) return 'wealth-performance';
		return 'wealth-portfolio-detail';
	}
	if (cleanPath.startsWith('/portal/wealth/transactions/') && method === 'DELETE') return 'wealth-delete-transaction';

	// Documents
	if (cleanPath.startsWith('/portal/documents/') && method === 'GET') return 'document-detail';
	if (cleanPath.startsWith('/portal/documents/') && method === 'PUT') return 'document-update';
	if (cleanPath.startsWith('/portal/documents/') && method === 'DELETE') return 'document-delete';

	// Folders
	if (cleanPath.startsWith('/portal/folders/') && method === 'PUT') return 'folder-update';
	if (cleanPath.startsWith('/portal/folders/') && method === 'DELETE') return 'folder-delete';

	// Attachments
	if (cleanPath.startsWith('/portal/attachments/') && method === 'PUT') return 'attachment-update';
	if (cleanPath.startsWith('/portal/attachments/') && method === 'DELETE') return 'attachment-delete';

	// Mindscape
	if (cleanPath.startsWith('/portal/mindscape/social/') && method === 'GET') return 'mindscape-social-detail';
	if (cleanPath.startsWith('/portal/mindscape/territory/') && method === 'PUT') return 'mindscape-territory-visibility';
	if (cleanPath.startsWith('/portal/mindscape/territory/')) return 'mindscape-territory-detail';

	// Intel
	if (cleanPath.startsWith('/portal/intel/market/')) return 'intel-market-detail';
	if (cleanPath.startsWith('/portal/intel/')) return 'intel';

	// Connections parameterized
	if (cleanPath.startsWith('/portal/connections/') && cleanPath.endsWith('/accept')) return 'connection-accept';
	if (cleanPath.startsWith('/portal/connections/') && cleanPath.endsWith('/reject')) return 'connection-reject';
	if (cleanPath.startsWith('/portal/connections/') && cleanPath.endsWith('/block')) return 'connection-block';
	if (cleanPath.startsWith('/portal/connections/') && cleanPath.endsWith('/overlap')) return 'connection-overlap';
	if (cleanPath.startsWith('/portal/connections/') && method === 'DELETE') return 'connection-delete';

	// Contexts parameterized
	if (cleanPath.match(/\/portal\/contexts\/[^/]+\/territories\//)) {
		return method === 'DELETE' ? 'context-remove-territory' : 'context-add-territory';
	}
	if (cleanPath.match(/\/portal\/contexts\/[^/]+\/grant\//)) {
		return method === 'DELETE' ? 'context-revoke-access' : 'context-grant-access';
	}
	if (cleanPath.match(/\/portal\/contexts\/[^/]+\/territories$/)) return 'context-territories';
	if (cleanPath.match(/\/portal\/contexts\/[^/]+\/connections$/)) return 'context-connections';
	if (cleanPath.startsWith('/portal/contexts/') && method === 'PUT') return 'context-update';
	if (cleanPath.startsWith('/portal/contexts/') && method === 'DELETE') return 'context-delete';

	// Providers parameterized
	if (cleanPath.startsWith('/portal/providers/') && cleanPath.endsWith('/test')) return 'provider-test';
	if (cleanPath.startsWith('/portal/providers/') && method === 'PUT') return 'provider-update';
	if (cleanPath.startsWith('/portal/providers/') && method === 'DELETE') return 'provider-delete';

	// Fallback for sensitive paths that don't have an explicit mapping yet:
	// derive a type from the path so it reaches the server (which may handle it).
	// The server will return a 404 error for unknown types, which is better than
	// throwing client-side and blocking the UI.
	if (isSensitivePath(cleanPath)) {
		const segments = cleanPath.replace('/portal/', '').split('/');
		return segments.join('-');
	}

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
