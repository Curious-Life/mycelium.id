<script lang="ts">
	import { browser } from '$app/environment';
	import { api, apiGet, apiPost, apiPut } from '$lib/api';

	interface Context {
		id: string;
		name: string;
		is_private: number;
		is_default: number;
		territory_count: number;
	}

	interface Territory {
		territory_id: number;
		name: string;
		essence: string | null;
		realm_id: number | null;
	}

	interface Connection {
		id: string;
		other_handle: string;
		other_display_name: string | null;
	}

	let contexts = $state<Context[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);

	// Selected context
	let selectedContext = $state<Context | null>(null);
	let contextTerritories = $state<Territory[]>([]);
	let contextGrants = $state<any[]>([]);
	let detailLoading = $state(false);

	// Create form
	let newName = $state('');
	let creating = $state(false);

	// Add territory
	let showAddTerritory = $state(false);

	// Connections for granting
	let connections = $state<Connection[]>([]);

	$effect(() => {
		if (browser) {
			loadContexts();
			loadConnections();
		}
	});

	async function loadContexts() {
		try {
			const data = await apiGet<{ contexts: Context[] }>('/portal/contexts');
			contexts = data.contexts;
		} catch {} finally { loading = false; }
	}

	async function loadConnections() {
		try {
			const data = await apiGet<{ connections: Connection[] }>('/portal/connections');
			connections = data.connections;
		} catch {}
	}

	async function createContext() {
		if (!newName.trim()) return;
		creating = true;
		try {
			await apiPost('/portal/contexts', { name: newName.trim() });
			newName = '';
			await loadContexts();
			showSuccess('Context created');
		} catch (e: any) {
			error = e.message;
		} finally { creating = false; }
	}

	async function deleteContext(id: string) {
		if (!confirm('Delete this context? Territories will revert to Private visibility.')) return;
		try {
			await api(`/portal/contexts/${id}`, { method: 'DELETE' });
			if (selectedContext?.id === id) { selectedContext = null; }
			await loadContexts();
			showSuccess('Context deleted');
		} catch (e: any) { error = e.message; }
	}

	async function selectContext(ctx: Context) {
		selectedContext = ctx;
		detailLoading = true;
		try {
			const [terrData, grantData] = await Promise.all([
				apiGet<{ territories: Territory[] }>(`/portal/contexts/${ctx.id}/territories`),
				apiGet<{ grants: any[] }>(`/portal/contexts/${ctx.id}/connections`),
			]);
			contextTerritories = terrData.territories;
			contextGrants = grantData.grants;
		} catch (e: any) { error = e.message; }
		detailLoading = false;
	}

	async function removeTerritory(territoryId: number) {
		if (!selectedContext) return;
		try {
			await api(`/portal/contexts/${selectedContext.id}/territories/${territoryId}`, { method: 'DELETE' });
			contextTerritories = contextTerritories.filter(t => t.territory_id !== territoryId);
			showSuccess('Territory removed');
		} catch (e: any) { error = e.message; }
	}

	async function grantConnection(connId: string) {
		if (!selectedContext) return;
		try {
			await apiPost(`/portal/contexts/${selectedContext.id}/grant/${connId}`, {});
			await selectContext(selectedContext);
			showSuccess('Access granted');
		} catch (e: any) { error = e.message; }
	}

	async function revokeGrant(connId: string) {
		if (!selectedContext) return;
		try {
			await api(`/portal/contexts/${selectedContext.id}/grant/${connId}`, { method: 'DELETE' });
			contextGrants = contextGrants.filter(g => g.connection_id !== connId);
			showSuccess('Access revoked');
		} catch (e: any) { error = e.message; }
	}

	function showSuccess(msg: string) {
		success = msg;
		setTimeout(() => success = null, 3000);
	}
</script>

<svelte:head>
	<title>Sharing Contexts - Mycelium</title>
</svelte:head>

<div class="contexts-page">
	<div class="header">
		<h1>Sharing Contexts</h1>
		<p class="subtitle">Group territories into named contexts and share them with specific connections</p>
	</div>

	<!-- Create form -->
	<form class="create-form" onsubmit={(e) => { e.preventDefault(); createContext(); }}>
		<input type="text" bind:value={newName} placeholder="New context name..." class="input-sm" maxlength="50" />
		<button type="submit" disabled={creating || !newName.trim()} class="btn-sm btn-primary">
			{creating ? 'Creating...' : 'Create'}
		</button>
	</form>

	{#if loading}
		<div class="loading">Loading contexts...</div>
	{:else if contexts.length === 0}
		<div class="empty">
			<p>No sharing contexts yet</p>
			<p class="empty-sub">Create contexts like "Work Self" or "Social Self" to control what different connections can see</p>
		</div>
	{:else}
		<div class="layout">
			<!-- Context list -->
			<div class="context-list">
				{#each contexts as ctx}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="context-card"
						class:selected={selectedContext?.id === ctx.id}
						onclick={() => selectContext(ctx)}
					>
						<div class="ctx-name">
							{#if ctx.is_private}<span class="ctx-lock">&#128274;</span>{/if}
							{ctx.name}
						</div>
						<div class="ctx-meta">
							{ctx.territory_count} territories
							{#if ctx.is_default}<span class="ctx-badge">default</span>{/if}
						</div>
						{#if !ctx.is_default}
							<button
								class="ctx-delete"
								onclick={(e) => { e.stopPropagation(); deleteContext(ctx.id); }}
								title="Delete context"
							>&times;</button>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Detail panel -->
			{#if selectedContext}
				<div class="detail-panel">
					<h2>{selectedContext.name}</h2>
					{#if selectedContext.is_private}
						<p class="private-notice">This context is always private and cannot be shared.</p>
					{/if}

					{#if detailLoading}
						<div class="loading">Loading...</div>
					{:else}
						<!-- Territories in this context -->
						<div class="detail-section">
							<h3 class="section-label">Territories ({contextTerritories.length})</h3>
							{#if contextTerritories.length === 0}
								<p class="empty-hint">No territories assigned. Add territories from your Mindscape.</p>
							{:else}
								{#each contextTerritories as t}
									<div class="terr-row">
										<div class="terr-info">
											<span class="terr-name">{t.name || `Territory ${t.territory_id}`}</span>
											{#if t.essence}
												<span class="terr-essence">{t.essence}</span>
											{/if}
										</div>
										<button class="btn-tiny btn-ghost" onclick={() => removeTerritory(t.territory_id)}>Remove</button>
									</div>
								{/each}
							{/if}
						</div>

						<!-- Shared with (connections) -->
						{#if !selectedContext.is_private}
							<div class="detail-section">
								<h3 class="section-label">Shared with</h3>
								{#if contextGrants.length === 0}
									<p class="empty-hint">Not shared with anyone yet.</p>
								{:else}
									{#each contextGrants as g}
										<div class="grant-row">
											<span class="grant-handle">@{g.handle || 'unknown'}</span>
											<button class="btn-tiny btn-ghost btn-danger" onclick={() => revokeGrant(g.connection_id)}>Revoke</button>
										</div>
									{/each}
								{/if}

								<!-- Grant to a connection -->
								{#if connections.length > 0}
									<div class="grant-add">
										<select class="input-sm" onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) grantConnection(v); (e.target as HTMLSelectElement).value = ''; }}>
											<option value="">Grant access to...</option>
											{#each connections.filter(c => !contextGrants.some(g => g.connection_id === c.id)) as conn}
												<option value={conn.id}>@{conn.other_handle}</option>
											{/each}
										</select>
									</div>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="toast error">{error}</div>
	{/if}
	{#if success}
		<div class="toast success">{success}</div>
	{/if}
</div>

<style>
	.contexts-page {
		padding: 2rem;
		max-width: 900px;
		margin: 0 auto;
		height: 100%;
		overflow-y: auto;
	}

	.header { margin-bottom: 1.5rem; }
	.header h1 { font-size: 1.3rem; font-weight: 600; color: var(--color-text-emphasis); }
	.subtitle { font-size: 0.8rem; color: var(--color-text-tertiary); margin-top: 0.25rem; }

	.create-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
	.input-sm {
		padding: 0.4rem 0.75rem;
		font-size: 0.8rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		outline: none;
		flex: 1;
		max-width: 300px;
	}
	.input-sm:focus { border-color: var(--color-accent-aurum); }

	.layout { display: grid; grid-template-columns: 240px 1fr; gap: 1.5rem; }
	@media (max-width: 640px) { .layout { grid-template-columns: 1fr; } }

	.context-list { display: flex; flex-direction: column; gap: 0.4rem; }
	.context-card {
		display: block; width: 100%; text-align: left;
		padding: 0.75rem 1rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
		position: relative;
	}
	.context-card:hover { border-color: var(--color-text-tertiary); }
	.context-card.selected { border-color: var(--color-accent-aurum); background: var(--color-elevated); }
	.ctx-name { font-size: 0.85rem; font-weight: 500; color: var(--color-text-primary); }
	.ctx-lock { margin-right: 0.25rem; }
	.ctx-meta { font-size: 0.7rem; color: var(--color-text-tertiary); margin-top: 0.15rem; }
	.ctx-badge {
		display: inline-block; padding: 1px 5px; border-radius: 3px;
		background: var(--color-accent-aurum, #E5B84C)18; color: var(--color-accent-aurum);
		font-size: 0.6rem; margin-left: 0.5rem;
	}
	.ctx-delete {
		position: absolute; top: 4px; right: 6px;
		background: none; border: none; color: var(--color-text-tertiary);
		cursor: pointer; font-size: 1rem; line-height: 1; padding: 2px;
		opacity: 0; transition: opacity 0.15s;
	}
	.context-card:hover .ctx-delete { opacity: 1; }
	.ctx-delete:hover { color: var(--color-accent-coral); }

	.detail-panel {
		background: var(--color-surface); border: 1px solid var(--color-border);
		border-radius: 12px; padding: 1.25rem;
	}
	.detail-panel h2 { font-size: 1rem; font-weight: 600; color: var(--color-text-emphasis); margin-bottom: 0.75rem; }
	.private-notice { font-size: 0.75rem; color: var(--color-accent-coral); margin-bottom: 1rem; }

	.detail-section { margin-bottom: 1.25rem; }
	.section-label {
		font-family: var(--font-mono); font-size: 0.6rem; font-weight: 500;
		letter-spacing: 0.12em; text-transform: uppercase;
		color: var(--color-accent-aurum); margin-bottom: 0.5rem;
	}

	.terr-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: 0.5rem 0; border-bottom: 1px solid var(--color-border);
	}
	.terr-row:last-child { border-bottom: none; }
	.terr-info { flex: 1; }
	.terr-name { font-size: 0.8rem; color: var(--color-text-primary); }
	.terr-essence { display: block; font-size: 0.7rem; color: var(--color-text-tertiary); margin-top: 0.1rem; }

	.grant-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: 0.4rem 0;
	}
	.grant-handle { font-size: 0.8rem; font-weight: 500; color: var(--color-text-primary); }
	.grant-add { margin-top: 0.75rem; }

	.btn-sm { padding: 0.35rem 0.75rem; font-size: 0.75rem; border-radius: 6px; cursor: pointer; border: none; font-weight: 500; }
	.btn-primary { background: var(--color-accent-aurum); color: #000; }
	.btn-primary:disabled { opacity: 0.5; cursor: default; }
	.btn-ghost { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); }
	.btn-tiny { padding: 0.2rem 0.5rem; font-size: 0.65rem; border-radius: 4px; cursor: pointer; border: none; }
	.btn-danger { color: var(--color-accent-coral); }

	.loading { text-align: center; padding: 2rem; color: var(--color-text-tertiary); font-size: 0.85rem; }
	.empty { text-align: center; padding: 3rem 2rem; color: var(--color-text-tertiary); }
	.empty-sub { font-size: 0.78rem; margin-top: 0.5rem; }
	.empty-hint { font-size: 0.75rem; color: var(--color-text-tertiary); }

	.toast {
		position: fixed; bottom: 2rem; left: 50%; transform: translateX(-50%);
		padding: 0.6rem 1.2rem; border-radius: 8px; font-size: 0.8rem;
		z-index: 100; animation: fadeIn 0.2s ease;
	}
	.toast.error { background: var(--color-accent-coral); color: #fff; }
	.toast.success { background: var(--color-accent-jade); color: #000; }

	@keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } }
</style>
