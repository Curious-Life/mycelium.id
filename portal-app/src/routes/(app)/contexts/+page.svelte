<script lang="ts">
	import { browser } from '$app/environment';
	import { api, apiGet, apiPost } from '$lib/api';

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

	let selectedContext = $state<Context | null>(null);
	let contextTerritories = $state<Territory[]>([]);
	let contextGrants = $state<any[]>([]);
	let detailLoading = $state(false);

	let newName = $state('');
	let creating = $state(false);
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
			showSuccess('Space created');
		} catch (e: any) { error = e.message; } finally { creating = false; }
	}

	async function deleteContext(id: string) {
		if (!confirm('Delete this space? Territories will revert to Private.')) return;
		try {
			await api(`/portal/contexts/${id}`, { method: 'DELETE' });
			if (selectedContext?.id === id) selectedContext = null;
			await loadContexts();
			showSuccess('Space deleted');
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
	<title>Spaces — Mycelium</title>
</svelte:head>

<div class="spaces-page">
	<div class="page-header">
		<h1>Spaces</h1>
		<p class="page-desc">Curate which parts of your Mycelium different people can see</p>
	</div>

	{#if loading}
		<div class="loading-state">
			<div class="spinner"></div>
		</div>
	{:else}
		<!-- Space cards -->
		<div class="spaces-grid">
			{#each contexts as ctx}
				<button
					class="space-card"
					class:selected={selectedContext?.id === ctx.id}
					class:is-private={ctx.is_private}
					onclick={() => selectContext(ctx)}
				>
					<div class="space-icon">
						{#if ctx.is_private}
							<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
							</svg>
						{:else}
							<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
							</svg>
						{/if}
					</div>
					<div class="space-info">
						<span class="space-name">{ctx.name}</span>
						<span class="space-meta">
							{ctx.territory_count} territories
							{#if ctx.is_default}<span class="space-badge">default</span>{/if}
						</span>
					</div>
					{#if !ctx.is_default && !ctx.is_private}
						<button class="space-delete" onclick={(e) => { e.stopPropagation(); deleteContext(ctx.id); }} title="Delete">&times;</button>
					{/if}
				</button>
			{/each}

			<!-- Create new -->
			<form class="space-card create-card" onsubmit={(e) => { e.preventDefault(); createContext(); }}>
				<input
					type="text"
					bind:value={newName}
					placeholder="New space..."
					class="create-input"
					maxlength="50"
				/>
				<button type="submit" disabled={creating || !newName.trim()} class="create-btn">
					{creating ? '...' : '+'}
				</button>
			</form>
		</div>

		<!-- Selected space detail -->
		{#if selectedContext}
			<div class="detail">
				<div class="detail-header">
					<h2>{selectedContext.name}</h2>
					{#if selectedContext.is_private}
						<span class="private-label">Private — only you can see this</span>
					{/if}
				</div>

				{#if detailLoading}
					<div class="loading-state"><div class="spinner"></div></div>
				{:else}
					<!-- Territories -->
					<div class="detail-section">
						<h3>Territories</h3>
						{#if contextTerritories.length === 0}
							<p class="empty-hint">No territories in this space yet. Set territory visibility to this space from the Mycelium view.</p>
						{:else}
							<div class="territory-grid">
								{#each contextTerritories as t}
									<div class="territory-chip">
										<div class="chip-content">
											<span class="chip-name">{t.name || `T${t.territory_id}`}</span>
											{#if t.essence}
												<span class="chip-essence">{t.essence}</span>
											{/if}
										</div>
										<button class="chip-remove" onclick={() => removeTerritory(t.territory_id)}>&times;</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Shared with -->
					{#if !selectedContext.is_private}
						<div class="detail-section">
							<h3>Shared with</h3>
							{#if contextGrants.length === 0}
								<p class="empty-hint">Not shared with anyone. Grant access to let connections see territories in this space.</p>
							{:else}
								<div class="grants-list">
									{#each contextGrants as g}
										<div class="grant-chip">
											<span class="grant-handle">@{g.handle || 'unknown'}</span>
											<button class="chip-remove" onclick={() => revokeGrant(g.connection_id)}>&times;</button>
										</div>
									{/each}
								</div>
							{/if}

							{#if connections.filter(c => !contextGrants.some(g => g.connection_id === c.id)).length > 0}
								<select class="grant-select" onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) grantConnection(v); (e.target as HTMLSelectElement).value = ''; }}>
									<option value="">Grant access to...</option>
									{#each connections.filter(c => !contextGrants.some(g => g.connection_id === c.id)) as conn}
										<option value={conn.id}>@{conn.other_handle}</option>
									{/each}
								</select>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	{/if}

	{#if error}<div class="toast error">{error}</div>{/if}
	{#if success}<div class="toast success">{success}</div>{/if}
</div>

<style>
	.spaces-page {
		padding: 24px;
		max-width: 800px;
		margin: 0 auto;
		height: 100%;
		overflow-y: auto;
	}
	.page-header { margin-bottom: 24px; }
	.page-header h1 {
		font-size: 18px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0 0 4px;
	}
	.page-desc {
		font-size: 13px;
		color: var(--color-text-tertiary);
		margin: 0;
	}
	.loading-state {
		display: flex;
		justify-content: center;
		padding: 40px;
	}
	.spinner {
		width: 20px; height: 20px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* Space cards grid */
	.spaces-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 10px;
		margin-bottom: 24px;
	}
	.space-card {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.15s;
		text-align: left;
		position: relative;
		color: inherit;
		font: inherit;
	}
	.space-card:hover {
		border-color: var(--color-accent-aurum);
		background: var(--color-elevated);
	}
	.space-card.selected {
		border-color: var(--color-accent-aurum);
		box-shadow: 0 0 12px rgba(229, 184, 76, 0.15);
	}
	.space-card.is-private {
		opacity: 0.7;
	}
	.space-icon {
		color: var(--color-text-tertiary);
		flex-shrink: 0;
	}
	.space-card.selected .space-icon { color: var(--color-accent-aurum); }
	.space-info { flex: 1; min-width: 0; }
	.space-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-primary);
		display: block;
	}
	.space-meta {
		font-size: 11px;
		color: var(--color-text-tertiary);
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.space-badge {
		font-size: 9px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 1px 5px;
		border-radius: 3px;
		background: rgba(91, 159, 232, 0.12);
		color: var(--color-accent);
	}
	.space-delete {
		position: absolute;
		top: 6px;
		right: 8px;
		background: none;
		border: none;
		color: var(--color-text-tertiary);
		font-size: 16px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s;
		padding: 2px;
		line-height: 1;
	}
	.space-card:hover .space-delete { opacity: 1; }
	.space-delete:hover { color: var(--color-accent-coral); }

	/* Create card */
	.create-card {
		border-style: dashed;
		cursor: default;
	}
	.create-input {
		flex: 1;
		background: transparent;
		border: none;
		color: var(--color-text-primary);
		font-size: 13px;
		outline: none;
		min-width: 0;
	}
	.create-input::placeholder { color: var(--color-text-tertiary); }
	.create-btn {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 1px solid var(--color-border);
		background: transparent;
		color: var(--color-text-secondary);
		font-size: 18px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
		flex-shrink: 0;
	}
	.create-btn:hover:not(:disabled) {
		border-color: var(--color-accent-aurum);
		color: var(--color-accent-aurum);
	}
	.create-btn:disabled { opacity: 0.3; cursor: not-allowed; }

	/* Detail panel */
	.detail {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		padding: 20px;
	}
	.detail-header {
		margin-bottom: 16px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--color-border);
	}
	.detail-header h2 {
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0;
	}
	.private-label {
		font-size: 11px;
		color: var(--color-text-tertiary);
		margin-top: 4px;
		display: block;
	}
	.detail-section {
		margin-bottom: 16px;
	}
	.detail-section:last-child { margin-bottom: 0; }
	.detail-section h3 {
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-text-tertiary);
		margin: 0 0 10px;
	}
	.empty-hint {
		font-size: 12px;
		color: var(--color-text-tertiary);
		margin: 0;
		line-height: 1.5;
	}

	/* Territory chips */
	.territory-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.territory-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		max-width: 280px;
	}
	.chip-content {
		flex: 1;
		min-width: 0;
	}
	.chip-name {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-text-primary);
		display: block;
	}
	.chip-essence {
		font-size: 10px;
		color: var(--color-text-tertiary);
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.chip-remove {
		background: none;
		border: none;
		color: var(--color-text-tertiary);
		font-size: 14px;
		cursor: pointer;
		padding: 0 2px;
		line-height: 1;
		flex-shrink: 0;
	}
	.chip-remove:hover { color: var(--color-accent-coral); }

	/* Grants */
	.grants-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 10px;
	}
	.grant-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		background: rgba(91, 159, 232, 0.08);
		border: 1px solid rgba(91, 159, 232, 0.2);
		border-radius: 16px;
	}
	.grant-handle {
		font-size: 12px;
		font-weight: 500;
		color: var(--color-accent);
	}
	.grant-select {
		margin-top: 8px;
		padding: 6px 10px;
		font-size: 12px;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		cursor: pointer;
	}

	/* Toasts */
	.toast {
		position: fixed;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		padding: 8px 20px;
		border-radius: 8px;
		font-size: 13px;
		font-weight: 500;
		z-index: 100;
		animation: toast-in 0.3s ease-out;
	}
	.toast.error {
		background: rgba(248, 113, 113, 0.15);
		border: 1px solid rgba(248, 113, 113, 0.3);
		color: var(--color-accent-coral);
	}
	.toast.success {
		background: rgba(74, 222, 128, 0.15);
		border: 1px solid rgba(74, 222, 128, 0.3);
		color: var(--color-accent-jade);
	}
	@keyframes toast-in {
		from { opacity: 0; transform: translateX(-50%) translateY(8px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	@media (max-width: 767px) {
		.spaces-page { padding: 16px; }
		.spaces-grid { grid-template-columns: 1fr; }
	}
</style>
