<script lang="ts">
	// The workspace content area. Phase A: a single pane. Phase B widens this to
	// recursively render a pane tree (leaf → Pane, split → SplitPane).
	import Pane from './Pane.svelte';
	import { workspace } from '$lib/workspace/store';
</script>

<div class="workspace">
	<Pane pane={$workspace.root} />
</div>

<style>
	.workspace { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
</style>
