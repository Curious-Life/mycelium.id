import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	response.headers.set('Content-Security-Policy', [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"font-src 'self' https://fonts.gstatic.com",
		"img-src 'self' data: blob: https://*.basemaps.cartocdn.com",
		"connect-src 'self'",
		"worker-src 'self' blob:",
		// The managed-connect Turnstile widget is a CROSS-ORIGIN iframe to the
		// control plane (Cloudflare's script runs THERE, never in this origin), so
		// we only allow framing it — no script-src/connect-src for Cloudflare here.
		// Default control plane; self-hosters on a custom control plane adjust this
		// (dev only — the Tauri app + static server set no CSP). See O2 widget.
		"frame-src https://connect.mycelium.id",
		"frame-ancestors 'none'",
	].join('; '));

	return response;
};
