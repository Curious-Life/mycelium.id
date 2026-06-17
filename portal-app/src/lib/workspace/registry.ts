// lib/workspace/registry.ts — the single source of truth for what can be a tab.
//
// Each entry maps a viewId to a lazily-imported view component (de-routed from
// the old route page) plus its tab metadata. `singleton: true` means only one
// tab of that view may exist (opening it again focuses the existing one). A
// `key(params)` lets a non-singleton view be singleton-PER-KEY (e.g. one tab per
// document path), so re-opening the same item focuses it instead of duplicating.
import type { Component } from 'svelte';

export interface ViewDef {
	title: string;
	icon: string;
	singleton?: boolean;
	key?: (params: Record<string, unknown>) => string;
	// Heterogeneous registry of prop-less view components. svelte2tsx types each
	// view's default export as `Component<Record<string, never>>`, which is not
	// assignable to a fixed prop shape — `Component<any>` accepts any view here.
	load: () => Promise<{ default: Component<any> }>;
}

export const REGISTRY: Record<string, ViewDef> = {
	mindscape: {
		title: 'Mycelium', icon: 'ratio', singleton: true,
		load: () => import('$lib/views/MindscapeView.svelte'),
	},
	library: {
		// Singleton (Phase C): one Library tab; its open doc rides in params.doc
		// (mirrored to /library?doc=…). Per-doc multi-tabs were never realized and
		// would mismatch keys when params mutate — see the Phase C design doc.
		title: 'Library', icon: 'folder', singleton: true,
		load: () => import('$lib/views/LibraryView.svelte'),
	},
	media: {
		// Was stranded as a route page ((app)/media/+page.svelte): the (app) layout
		// renders the workspace BY REGISTRY, not the route, so the media grid rendered
		// into a hidden div and never showed. De-routed into a view + registered here
		// so the "Media" nav button actually shows the grid/lightbox.
		title: 'Media', icon: 'image', singleton: true,
		load: () => import('$lib/views/MediaView.svelte'),
	},
	streams: {
		// The merged data surface (NAV-IA-LOCK-2026-06-08): Import + Timeline behind
		// one tab. params.facet ('stream' | 'sources') selects the in-view panel and
		// is mirrored to /streams?facet=… . Singleton — /timeline and /import deep-links
		// both focus this one tab and just switch the facet.
		title: 'Streams', icon: 'streams', singleton: true,
		load: () => import('$lib/views/StreamsView.svelte'),
	},
	connections: {
		title: 'Connections', icon: 'connections', singleton: true,
		load: () => import('$lib/views/ConnectionsView.svelte'),
	},
	spaces: {
		title: 'Spaces', icon: 'spaces', singleton: true,
		load: () => import('$lib/views/SpacesView.svelte'),
	},
	space: {
		// One tab per space (keyed by id); the detail view reads params.id.
		title: 'Space', icon: 'spaces', key: (p) => `space:${p.id}`,
		load: () => import('$lib/views/SpaceDetailView.svelte'),
	},
	contexts: {
		title: 'Sharing', icon: 'contexts', singleton: true,
		load: () => import('$lib/views/ContextsView.svelte'),
	},
	'curious-life': {
		title: 'Curious Life', icon: 'compass', singleton: true,
		load: () => import('$lib/views/CuriousLifeView.svelte'),
	},
	claims: {
		title: 'Claims', icon: 'profile', singleton: true,
		load: () => import('$lib/views/ClaimsView.svelte'),
	},
	vitality: {
		// De-routed from (app)/vitality/+page.svelte (same stranded-in-a-hidden-div
		// bug the `media` note above describes). Live backend: /vitality/snapshot +
		// /trajectory/*. Linked from MilestoneBanner + the Mindscape movement pill.
		title: 'Vitality', icon: 'compass', singleton: true,
		load: () => import('$lib/views/VitalityView.svelte'),
	},
	body: {
		// De-routed full page. Live backend: /health/summary.
		title: 'Body', icon: 'ratio', singleton: true,
		load: () => import('$lib/views/BodyView.svelte'),
	},
	agents: {
		// De-routed full page. Live backend: /agents + /providers (11 handlers).
		title: 'Agents', icon: 'people', singleton: true,
		load: () => import('$lib/views/AgentsView.svelte'),
	},
	settings: {
		title: 'Settings', icon: 'settings', singleton: true,
		load: () => import('$lib/views/SettingsView.svelte'),
	},
};

export function viewExists(id: string): boolean {
	return Object.prototype.hasOwnProperty.call(REGISTRY, id);
}

export function getView(id: string): ViewDef | null {
	return REGISTRY[id] ?? null;
}

/** Stable identity for a (viewId, params) pair — drives focus-vs-open. */
export function tabKey(id: string, params: Record<string, unknown>): string {
	const v = REGISTRY[id];
	if (!v) return id;
	if (v.singleton) return id;
	return v.key ? v.key(params) : id;
}
