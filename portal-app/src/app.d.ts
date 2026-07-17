// Ambient declarations for the SvelteKit app.

declare global {
	// Baked in at build time by vite.config.ts `define` from the repo root
	// package.json — the one version number the release flow bumps. Shown as the
	// subtle badge in the sidebar footer (Sidebar.svelte).
	const __APP_VERSION__: string;
}

export {};
