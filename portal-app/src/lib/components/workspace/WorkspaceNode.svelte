<script lang="ts">
	// Recursively render the pane tree: a leaf → Pane, a split → SplitPane with its
	// two children (passed as snippets so SplitPane needn't import this component,
	// avoiding a hard circular dependency).
	import Pane from './Pane.svelte';
	import SplitPane from './SplitPane.svelte';
	import WorkspaceNode from './WorkspaceNode.svelte';
	import type { WsNode } from '$lib/workspace/types';

	let { node }: { node: WsNode } = $props();
</script>

{#if node.kind === 'leaf'}
	<Pane pane={node} />
{:else}
	<SplitPane split={node}>
		{#snippet a()}<WorkspaceNode node={node.children[0]} />{/snippet}
		{#snippet b()}<WorkspaceNode node={node.children[1]} />{/snippet}
	</SplitPane>
{/if}
