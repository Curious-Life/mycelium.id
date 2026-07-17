import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// The app version, baked in at build time from the REPO root package.json (the
// single source the release flow bumps — same number the Tauri bundle and the
// updater manifest carry). Rendered as the subtle badge in the sidebar footer.
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// In production the SvelteKit build is served by the Node backend (server-rest.js)
// on the same origin, so all `/api`, `/auth`, `/oauth`, `/mcp` calls are relative.
// During `vite dev` we proxy those prefixes to the running backend so HMR works
// against real data. Backend defaults to the local loopback server on :8787
// (which is "always signed in" for loopback clients). Override with VITE_API_TARGET.
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8787';
const proxy = Object.fromEntries(
	['/api', '/auth', '/oauth', '/mcp', '/.well-known'].map((p) => [
		p,
		{ target: apiTarget, changeOrigin: true, ws: true }
	])
);

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__APP_VERSION__: JSON.stringify(appVersion)
	},
	server: {
		port: 5173,
		proxy
	}
});
