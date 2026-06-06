<script lang="ts">
	import { browser } from '$app/environment';
	import { api, apiGet, apiPost } from '$lib/api';

	interface Connection {
		id: string;
		other_handle: string;
		other_display_name: string | null;
		other_signature: string | null;
		other_avatar_url: string | null;
		other_user_id: string;
		other_depth: number;
		other_breadth: number;
		other_territory_count: number;
		other_realms_json: string | null;
		overlap_json: string | null;
		accepted_at: string;
	}

	interface PendingRequest {
		id: string;
		handle: string;
		display_name: string | null;
		signature: string | null;
		avatar_url: string | null;
		territory_count: number;
		realm_count: number;
		public_realms_json: string | null;
	}

	interface Overlap {
		shared: Array<{ name: string; my_depth: number; their_depth: number; my_essence: string; their_essence: string }>;
		myOnly: Array<{ name: string; essence: string; message_count: number }>;
		theirOnly: Array<{ name: string; essence: string; message_count: number }>;
		matchScore: number | null;
		shape: string;
		shapeLabel: string;
		sharedCount: number;
	}

	interface SentRequest {
		id: string;
		to_handle: string | null;
		to_display_name: string | null;
		to_avatar_url: string | null;
		status: string;
		created_at: string;
	}

	let connections = $state<Connection[]>([]);
	let pending = $state<PendingRequest[]>([]);
	let sent = $state<SentRequest[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);

	// Connect form
	let connectHandle = $state('');
	let connectMessage = $state('');
	let connecting = $state(false);

	// Overlap view
	let selectedConnection = $state<Connection | null>(null);
	let overlap = $state<Overlap | null>(null);
	let overlapLoading = $state(false);
	// What you've shared WITH the selected connection (the management hub).
	let shared = $state<{ peer_id: string | null; spaces: Array<{ id: string; name: string; role: string }>; contexts: Array<{ id: string; name: string; is_private: number }> }>({ peer_id: null, spaces: [], contexts: [] });
	let sharedLoading = $state(false);

	$effect(() => {
		if (browser) {
			loadConnections();
			loadPending();
			loadSent();
		}
	});

	async function loadConnections() {
		try {
			const data = await apiGet<{ connections: Connection[] }>('/portal/connections');
			connections = data.connections;
		} catch {} finally { loading = false; }
	}

	async function loadPending() {
		try {
			const data = await apiGet<{ requests: PendingRequest[] }>('/portal/connections/pending');
			pending = data.requests;
		} catch {}
	}

	async function loadSent() {
		try {
			const data = await apiGet<{ sent: SentRequest[] }>('/portal/connections/sent');
			sent = data.sent;
		} catch {}
	}

	async function sendRequest() {
		if (!connectHandle.trim()) return;
		connecting = true;
		error = null;
		try {
			await apiPost('/portal/connections/request', { toHandle: connectHandle.trim().replace(/^@/, ''), message: connectMessage.trim() || undefined });
			connectHandle = '';
			connectMessage = '';
			showSuccess('Request sent');
			loadSent();
		} catch (e: any) {
			error = e.message || 'Failed to send request';
		} finally { connecting = false; }
	}

	async function acceptRequest(id: string) {
		try {
			await apiPost(`/portal/connections/${id}/accept`, {});
			pending = pending.filter(r => r.id !== id);
			await loadConnections();
			showSuccess('Connected');
		} catch (e: any) { error = e.message; }
	}

	async function rejectRequest(id: string) {
		try {
			await apiPost(`/portal/connections/${id}/reject`, {});
			pending = pending.filter(r => r.id !== id);
		} catch (e: any) { error = e.message; }
	}

	async function disconnectConnection(id: string) {
		if (!confirm('Disconnect? You\'ll lose access to each other\'s shared territories.')) return;
		try {
			const res = await api(`/portal/connections/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed');
			connections = connections.filter(c => c.id !== id);
			selectedConnection = null;
			overlap = null;
			showSuccess('Disconnected');
		} catch (e: any) { error = e.message; }
	}

	async function viewOverlap(conn: Connection) {
		selectedConnection = conn;
		overlapLoading = true;
		overlap = null;
		loadShared(conn.id);
		try {
			const data = await apiGet<{ overlap: Overlap }>(`/portal/connections/${conn.id}/overlap`);
			overlap = data.overlap;
		} catch (e: any) {
			error = e.message || 'Failed to compute overlap';
		} finally { overlapLoading = false; }
	}

	async function loadShared(connId: string) {
		sharedLoading = true;
		shared = { peer_id: null, spaces: [], contexts: [] };
		try { shared = await apiGet(`/portal/connections/${connId}/shared`); }
		catch { /* leave empty */ }
		finally { sharedLoading = false; }
	}
	async function revokeSpaceShare(spaceId: string) {
		if (!shared.peer_id) return;
		try {
			await api(`/portal/spaces/${spaceId}/shares/${encodeURIComponent(shared.peer_id)}`, { method: 'DELETE' });
			if (selectedConnection) await loadShared(selectedConnection.id);
			showSuccess('Space access revoked');
		} catch (e: any) { error = e.message || 'Failed to revoke'; }
	}
	async function revokeContextGrant(contextId: string) {
		if (!selectedConnection) return;
		try {
			await api(`/portal/contexts/${contextId}/grant/${encodeURIComponent(selectedConnection.id)}`, { method: 'DELETE' });
			await loadShared(selectedConnection.id);
			showSuccess('Sharing revoked');
		} catch (e: any) { error = e.message || 'Failed to revoke'; }
	}

	function showSuccess(msg: string) {
		success = msg;
		setTimeout(() => success = null, 3000);
	}

	function shapeColor(shape: string): string {
		switch (shape) {
			case 'twin': return '#4ade80';
			case 'deep-collaborators': return '#E5B84C';
			case 'broad-kindred': return '#818cf8';
			case 'complementary': return '#f472b6';
			default: return 'var(--color-text-tertiary)';
		}
	}
</script>

<svelte:head>
	<title>Connections - Mycelium</title>
</svelte:head>

<div class="connections-page">
	<!-- Header + connect form -->
	<div class="header">
		<h1>Connections</h1>
		<form class="connect-form" onsubmit={(e) => { e.preventDefault(); sendRequest(); }}>
			<div class="connect-fields">
				<input type="text" bind:value={connectHandle} placeholder="@handle" class="connect-input" />
				<input type="text" bind:value={connectMessage} placeholder="Add a message (optional)" maxlength="200" class="connect-input connect-message" />
			</div>
			<button type="submit" disabled={connecting || !connectHandle.trim()} class="btn-sm btn-primary">
				{connecting ? 'Sending...' : 'Connect'}
			</button>
		</form>
	</div>

	<!-- Pending requests -->
	{#if pending.length > 0}
		<div class="section">
			<h2 class="section-label">Requests ({pending.length})</h2>
			{#each pending as req}
				<div class="request-card">
					<div class="request-info">
						<div class="request-identity">
							{#if req.avatar_url}
								<img src={req.avatar_url} alt="" class="conn-avatar" />
							{:else}
								<div class="conn-avatar-placeholder">@</div>
							{/if}
							<div>
								<span class="request-handle">@{req.handle}</span>
								{#if req.signature}
									<span class="request-sig">"{req.signature}"</span>
								{/if}
								<span class="request-meta">{req.territory_count} territories · {req.realm_count} realms</span>
							</div>
						</div>
					</div>
					<div class="request-actions">
						<button onclick={() => acceptRequest(req.id)} class="btn-sm btn-primary">Accept</button>
						<button onclick={() => rejectRequest(req.id)} class="btn-sm btn-ghost">Ignore</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Sent invites -->
	{#if sent.length > 0}
		<div class="section">
			<h2 class="section-label">Sent ({sent.length})</h2>
			{#each sent as s}
				<div class="request-card sent-card">
					<div class="request-info">
						<div class="request-identity">
							{#if s.to_avatar_url}
								<img src={s.to_avatar_url} alt="" class="conn-avatar" />
							{:else}
								<div class="conn-avatar-placeholder">@</div>
							{/if}
							<div>
								<span class="request-handle">@{s.to_handle || '?'}</span>
								<span class="request-meta">sent {new Date(s.created_at).toLocaleDateString()}</span>
							</div>
						</div>
					</div>
					<span class="sent-status">pending</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Connection list -->
	{#if loading}
		<div class="loading">Loading connections...</div>
	{:else if connections.length === 0 && pending.length === 0 && sent.length === 0}
		<div class="empty">
			<p>No connections yet</p>
			<p class="empty-sub">Enter a handle above to connect with someone on Mycelium</p>
		</div>
	{:else}
		<div class="section">
			<h2 class="section-label">Connected ({connections.length})</h2>
			{#each connections as conn}
				{@const cachedOverlap = conn.overlap_json ? JSON.parse(conn.overlap_json) : null}
				<button class="conn-card" class:selected={selectedConnection?.id === conn.id} onclick={() => viewOverlap(conn)}>
					<div class="conn-main">
						{#if conn.other_avatar_url}
							<img src={conn.other_avatar_url} alt="" class="conn-avatar" />
						{:else}
							<div class="conn-avatar-placeholder">@</div>
						{/if}
						<span class="conn-handle">@{conn.other_handle}</span>
						{#if cachedOverlap?.shapeLabel}
							<span class="conn-shape" style="color: {shapeColor(cachedOverlap.shape)}">{cachedOverlap.shapeLabel}</span>
						{/if}
						{#if cachedOverlap?.matchScore != null}
							<span class="conn-score">{cachedOverlap.matchScore}%</span>
						{/if}
					</div>
					{#if conn.other_signature}
						<div class="conn-sig">"{conn.other_signature}"</div>
					{/if}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Overlap detail -->
	{#if selectedConnection}
		<div class="overlap-panel">
			<div class="overlap-header">
				<h2>You & @{selectedConnection.other_handle}</h2>
				<button onclick={() => selectedConnection && disconnectConnection(selectedConnection.id)} class="btn-sm btn-ghost btn-danger">Disconnect</button>
			</div>

			{#if overlapLoading}
				<div class="loading">Computing overlap...</div>
			{:else if overlap}
				<!-- Score + shape -->
				<div class="overlap-summary">
					{#if overlap.matchScore != null}
						<span class="overlap-score">{overlap.matchScore}%</span>
					{:else}
						<span class="overlap-score-na">Not enough overlap to score</span>
					{/if}
					<span class="overlap-shape" style="color: {shapeColor(overlap.shape)}">{overlap.shapeLabel}</span>
				</div>

				<!-- Shared territories -->
				{#if overlap.shared.length > 0}
					<div class="overlap-section">
						<h3>Shared ({overlap.sharedCount})</h3>
						{#each overlap.shared as t}
							{@const maxDepth = Math.max(t.my_depth, t.their_depth, 1)}
							<div class="shared-territory">
								<div class="shared-name">{t.name}</div>
								<div class="depth-bars">
									<div class="depth-row">
										<span class="depth-label">you</span>
										<div class="depth-track">
											<div class="depth-fill" style="width: {t.my_depth / maxDepth * 100}%"></div>
										</div>
									</div>
									<div class="depth-row">
										<span class="depth-label">them</span>
										<div class="depth-track">
											<div class="depth-fill their" style="width: {t.their_depth / maxDepth * 100}%"></div>
										</div>
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Unique territories -->
				{#if overlap.myOnly.length > 0}
					<div class="overlap-section">
						<h3>Only You</h3>
						<div class="unique-tags">
							{#each overlap.myOnly as t}
								<span class="unique-tag" title={t.essence}>{t.name}</span>
							{/each}
						</div>
					</div>
				{/if}

				{#if overlap.theirOnly.length > 0}
					<div class="overlap-section">
						<h3>Only @{selectedConnection.other_handle}</h3>
						<div class="unique-tags">
							{#each overlap.theirOnly as t}
								<span class="unique-tag" title={t.essence}>{t.name}</span>
							{/each}
						</div>
					</div>
				{/if}
			{/if}

			<!-- What you've shared WITH this connection — manage it here -->
			<div class="overlap-section shared-mgmt">
				<h3>Shared with @{selectedConnection.other_handle}</h3>
				{#if sharedLoading}
					<div class="loading">Loading…</div>
				{:else if shared.spaces.length === 0 && shared.contexts.length === 0}
					<p class="shared-empty">Nothing shared yet. Share a space (Spaces → a space → Members) or a mindscape facet (Sharing) with this connection.</p>
				{:else}
					{#if shared.spaces.length > 0}
						<div class="shared-group">
							<span class="shared-kind">Spaces</span>
							{#each shared.spaces as s (s.id)}
								<div class="shared-row">
									<span class="shared-label">{s.name} <span class="shared-role">({s.role === 'contributor' ? 'can add' : 'can view'})</span></span>
									<button class="btn-revoke" onclick={() => revokeSpaceShare(s.id)}>Revoke</button>
								</div>
							{/each}
						</div>
					{/if}
					{#if shared.contexts.length > 0}
						<div class="shared-group">
							<span class="shared-kind">Mindscape facets</span>
							{#each shared.contexts as c (c.id)}
								<div class="shared-row">
									<span class="shared-label">{c.name}</span>
									<button class="btn-revoke" onclick={() => revokeContextGrant(c.id)}>Revoke</button>
								</div>
							{/each}
						</div>
					{/if}
				{/if}
			</div>
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
	.connections-page {
		padding: 2rem;
		max-width: 700px;
		margin: 0 auto;
		height: 100%;
		overflow-y: auto;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 2rem;
		flex-wrap: wrap;
	}
	.header h1 {
		font-size: 1.3rem;
		font-weight: 600;
		color: var(--color-text-emphasis);
	}

	.connect-form {
		display: flex;
		gap: 0.5rem;
		align-items: flex-end;
	}
	.connect-fields {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.connect-input {
		padding: 0.4rem 0.75rem;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		outline: none;
		width: 160px;
	}
	.connect-message {
		width: 240px;
		font-family: var(--font-sans);
	}
	.connect-input:focus { border-color: var(--color-accent-aurum); }

	.section { margin-bottom: 2rem; }
	.section-label {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-accent-aurum);
		margin-bottom: 0.75rem;
	}

	.request-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		margin-bottom: 0.5rem;
	}
	.request-info { display: flex; flex-direction: column; gap: 0.2rem; flex: 1; min-width: 0; }
	.request-identity { display: flex; align-items: center; gap: 0.75rem; }
	.conn-avatar {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
		border: 1.5px solid var(--color-border);
		flex-shrink: 0;
	}
	.conn-avatar-placeholder {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--color-elevated);
		border: 1.5px solid var(--color-border);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		flex-shrink: 0;
	}
	.request-handle { font-weight: 600; font-size: 0.9rem; color: var(--color-text-emphasis); }
	.request-sig { font-size: 0.78rem; color: var(--color-text-secondary); }
	.request-meta { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.request-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
	.sent-status {
		font-size: 0.68rem;
		font-family: var(--font-mono);
		color: var(--color-text-tertiary);
		padding: 0.2rem 0.5rem;
		background: var(--color-elevated);
		border-radius: 4px;
		flex-shrink: 0;
	}
	.sent-card { opacity: 0.7; }

	.conn-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 0.85rem 1rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		margin-bottom: 0.4rem;
		cursor: pointer;
		transition: all 0.15s;
		font-family: inherit;
		font-size: inherit;
		color: inherit;
	}
	.conn-card:hover { border-color: var(--color-accent-aurum); }
	.conn-card.selected { border-color: var(--color-accent-aurum); box-shadow: 0 0 12px rgba(229, 184, 76, 0.1); }

	.conn-main { display: flex; align-items: center; gap: 0.75rem; }
	.conn-handle { font-weight: 600; font-size: 0.88rem; color: var(--color-text-emphasis); }
	.conn-shape { font-size: 0.7rem; font-weight: 500; }
	.conn-score { font-family: var(--font-mono); font-size: 0.7rem; color: var(--color-text-tertiary); margin-left: auto; }
	.conn-sig { font-size: 0.75rem; color: var(--color-text-tertiary); margin-top: 0.25rem; }

	.overlap-panel {
		margin-top: 1.5rem;
		padding: 1.5rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 12px;
	}
	.shared-mgmt { border-top: 1px solid var(--color-border); margin-top: 1rem; padding-top: 1rem; }
	.shared-empty { font-size: 0.8rem; color: var(--color-text-tertiary); }
	.shared-group { margin-bottom: 0.75rem; }
	.shared-kind { display: block; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-tertiary); margin-bottom: 0.35rem; }
	.shared-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.35rem 0; }
	.shared-label { font-size: 0.85rem; color: var(--color-text-primary); }
	.shared-role { color: var(--color-text-tertiary); font-size: 0.75rem; }
	.btn-revoke { font-size: 0.7rem; color: var(--color-text-tertiary); background: none; border: none; cursor: pointer; flex-shrink: 0; }
	.btn-revoke:hover { color: var(--color-coral, #e5736a); }
	.overlap-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.25rem;
	}
	.overlap-header h2 { font-size: 1.1rem; font-weight: 600; color: var(--color-text-emphasis); }

	.overlap-summary {
		display: flex;
		align-items: baseline;
		gap: 1rem;
		margin-bottom: 1.5rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--color-border);
	}
	.overlap-score { font-size: 2rem; font-weight: 700; color: var(--color-accent-aurum); font-family: var(--font-mono); }
	.overlap-score-na { font-size: 0.82rem; color: var(--color-text-tertiary); }
	.overlap-shape { font-size: 0.85rem; font-weight: 500; }

	.overlap-section { margin-bottom: 1.5rem; }
	.overlap-section h3 {
		font-size: 0.65rem;
		font-family: var(--font-mono);
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--color-text-tertiary);
		margin-bottom: 0.6rem;
	}

	.shared-territory {
		padding: 0.6rem 0;
		border-bottom: 1px solid rgba(255,255,255,0.04);
	}
	.shared-territory:last-child { border-bottom: none; }
	.shared-name { font-size: 0.82rem; font-weight: 500; color: var(--color-text-primary); margin-bottom: 0.4rem; }

	.depth-bars { display: flex; flex-direction: column; gap: 0.2rem; }
	.depth-row { display: flex; align-items: center; gap: 0.5rem; }
	.depth-label { width: 35px; font-size: 0.65rem; color: var(--color-text-tertiary); }
	.depth-track { flex: 1; height: 4px; background: var(--color-elevated); border-radius: 2px; overflow: hidden; }
	.depth-fill { height: 100%; background: var(--color-accent-aurum); border-radius: 2px; }
	.depth-fill.their { background: var(--color-accent); }

	.unique-tags { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.unique-tag {
		font-size: 0.72rem;
		padding: 0.2rem 0.5rem;
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-secondary);
	}

	.loading { text-align: center; padding: 2rem; color: var(--color-text-tertiary); font-size: 0.82rem; }
	.empty { text-align: center; padding: 4rem 2rem; }
	.empty p { color: var(--color-text-secondary); font-size: 0.9rem; }
	.empty-sub { font-size: 0.78rem; color: var(--color-text-tertiary); margin-top: 0.25rem; }

	.btn-sm {
		padding: 0.35rem 0.75rem;
		font-size: 0.75rem;
		font-family: var(--font-sans);
		border-radius: 6px;
		cursor: pointer;
		border: none;
		transition: all 0.15s;
	}
	.btn-primary { background: var(--color-accent-aurum); color: var(--color-bg); font-weight: 500; }
	.btn-primary:hover { opacity: 0.9; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { background: transparent; color: var(--color-text-tertiary); border: 1px solid var(--color-border); }
	.btn-ghost:hover { color: var(--color-text-secondary); }
	.btn-danger { color: var(--color-accent-coral); border-color: rgba(248, 113, 113, 0.3); }
	.btn-danger:hover { color: #f87171; border-color: #f87171; }

	.toast {
		position: fixed;
		bottom: 1.5rem;
		left: 50%;
		transform: translateX(-50%);
		padding: 0.5rem 1.25rem;
		border-radius: 8px;
		font-size: 0.78rem;
		z-index: 100;
	}
	.toast.error { background: rgba(248, 113, 113, 0.15); border: 1px solid rgba(248, 113, 113, 0.3); color: #f87171; }
	.toast.success { background: rgba(74, 222, 128, 0.15); border: 1px solid rgba(74, 222, 128, 0.3); color: #4ade80; }
</style>
