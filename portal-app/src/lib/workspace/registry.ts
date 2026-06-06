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
	load: () => Promise<{ default: Component<Record<string, unknown>> }>;
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
	import: {
		title: 'Import', icon: 'import', singleton: true,
		load: () => import('$lib/views/ImportView.svelte'),
	},
	timeline: {
		title: 'Timeline', icon: 'tornado', singleton: true,
		load: () => import('$lib/views/TimelineView.svelte'),
	},
	profile: {
		title: 'Profile', icon: 'profile', singleton: true,
		load: () => import('$lib/views/ProfileView.svelte'),
	},
	connections: {
		title: 'Connections', icon: 'connections', singleton: true,
		load: () => import('$lib/views/ConnectionsView.svelte'),
	},
	'curious-life': {
		title: 'Curious Life', icon: 'compass', singleton: true,
		load: () => import('$lib/views/CuriousLifeView.svelte'),
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
