// lib/nav/config.ts — the SINGLE SOURCE OF TRUTH for the navigation SURFACES:
// the desktop sidebar, the mobile tab bar, and the header page-title.
//
// Why this exists: the sidebar, bottom tab bar, and header each used to hardcode
// their own list of destinations (and the PrimaryView union + a viewLabels map
// were two more). Four lists that had to be hand-kept in sync — and weren't,
// which is how nine feature pages ended up stranded and unreachable. Everything
// nav-surface now derives from this file.
//
// The workspace REGISTRY ($lib/workspace/registry.ts) remains the source of truth
// for what can be a TAB (it drives the ⌘K palette and the tab "+" menu). The two
// are linked by contract: every `id` here MUST be a registered view there, except
// `people`, which is a cluster entry routing to the Connections view.
import type { PrimaryView } from '$lib/stores/navigation';

export interface NavItem {
	/** Workspace viewId + route segment. Must exist in the REGISTRY (except `people`). */
	id: PrimaryView;
	label: string;
	/** Canonical route; a plain click is intercepted for SPA nav, modified clicks open a new tab. */
	href: string;
	/** Icon key rendered by the sidebar/tab-bar icon switch. */
	icon: string;
}

export interface NavSection {
	id: string;
	/** Eyebrow label shown above the group. Omitted for the top (primary) group. */
	label?: string;
	items: NavItem[];
}

// Primary destinations. These are also the four mobile bottom-tabs.
export const PRIMARY_NAV: NavItem[] = [
	{ id: 'mindscape', label: 'Mycelium', icon: 'ratio',   href: '/mindscape' },
	{ id: 'library',   label: 'Library',  icon: 'folder',  href: '/library' },
	{ id: 'streams',   label: 'Streams',  icon: 'streams', href: '/streams' },
	{ id: 'people',    label: 'People',   icon: 'people',  href: '/connections' },
];

// Sidebar sections rendered BELOW the primary group, each with an eyebrow label
// (the first group has none — it reads as a continuation of the primary list).
// Order (flat list, rendered after PRIMARY_NAV): Agents sits right below People;
// Curious Life is last. Body & Health is NOT a standalone item — it lives INSIDE
// Streams as the 'body' facet tab (/body deep-links there).
export const NAV_SECTIONS: NavSection[] = [
	{
		id: 'agents',
		label: 'Agents',
		items: [
			{ id: 'agents', label: 'Agents', icon: 'agents', href: '/agents' },
		],
	},
	{
		id: 'explore',
		items: [
			{ id: 'curious-life', label: 'Curious Life', icon: 'compass', href: '/curious-life' },
		],
	},
];

// Settings is pinned in the sidebar footer (not a section) — kept as a constant
// here so its label/href/icon still come from one place.
export const SETTINGS_NAV: NavItem = { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' };

// The People nav item is active across its whole cluster (Connections / Spaces /
// Sharing), whose sub-nav renders in the sidebar's contextual region.
export const PEOPLE_CLUSTER = new Set<string>(['people', 'connections', 'spaces', 'contexts']);

/** True when `view` should light up the given nav item (handles the People cluster). */
export function navItemActive(itemId: PrimaryView, view: string): boolean {
	return itemId === 'people' ? PEOPLE_CLUSTER.has(view) : view === itemId;
}

// Header page-title resolution. Sidebar/mobile labels come from the items above;
// the header also needs titles for views reached as deep tabs that are NOT
// sidebar destinations (e.g. a Library doc, the Settings panes, Vitality).
const EXTRA_LABELS: Record<string, string> = {
	timeline: 'Streams', // /timeline deep-links focus the Streams tab
	media: 'Media',
	profile: 'Profile',
	settings: 'Settings',
	connections: 'Connections',
	contexts: 'Sharing',
	claims: 'Claims',
	vitality: 'Vitality',
	import: 'Import',
	chat: 'Chat',
};

const ALL_ITEMS: NavItem[] = [...PRIMARY_NAV, ...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_NAV];

/** Resolve the header title for the current primary view. */
export function viewLabel(view: string): string {
	const item = ALL_ITEMS.find((i) => i.id === view);
	if (item) return item.label;
	return EXTRA_LABELS[view] ?? 'Mycelium';
}
