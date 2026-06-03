<script lang="ts">
	// The workspace content area — renders the pane tree (Phase B).
	import WorkspaceNode from './WorkspaceNode.svelte';
	import { workspace } from '$lib/workspace/store';
</script>

<div class="workspace">
	<WorkspaceNode node={$workspace.root} />
</div>

<style>
	.workspace { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
</style>
