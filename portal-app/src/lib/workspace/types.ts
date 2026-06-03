// lib/workspace/types.ts — the workspace layout model.
//
// Phase A ships a SINGLE pane (root is always a LeafPane). The SplitNode type is
// defined now so Phase B only has to widen `WorkspaceState.root` to `WsNode` and
// add the split operations — not rewrite the store shape.

export interface Tab {
	id: string;
	viewId: string;                       // key into the view registry
	params: Record<string, unknown>;      // e.g. { doc } for Library, { id } for a Space
	title: string;
	icon: string;
	closable: boolean;
}

export interface LeafPane {
	kind: 'leaf';
	id: string;
	tabs: Tab[];
	activeTabId: string | null;
}

// Reserved for Phase B (split panes). Not constructed in Phase A.
export interface SplitNode {
	kind: 'split';
	id: string;
	dir: 'h' | 'v';
	children: [WsNode, WsNode];
	sizes: [number, number];              // percentages, sum ~100
}

export type WsNode = LeafPane | SplitNode;

export interface RecentItem {
	viewId: string;
	params: Record<string, unknown>;
	title: string;
	icon: string;
	at: number;
}

export interface WorkspaceState {
	root: WsNode;                         // a tree of split nodes + leaf panes (Phase B)
	focusedPaneId: string;                // the leaf that new tabs open into
	recents: RecentItem[];
}
