<script lang="ts">
	import { browser } from '$app/environment';
	import { api, apiGet, apiPost } from '$lib/api';
	import { workspace } from '$lib/workspace/store';
	import { toasts } from '$lib/stores/toast';

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

	// Connect composer — a single handle field; opens on demand (always shown in
	// the empty state). The old free-text "message" field was a no-op (the request
	// route drops it), so it's gone.
	let composerOpen = $state(false);
	let connectHandle = $state('');
	let connecting = $state(false);

	// Detail pane
	let selectedConnection = $state<Connection | null>(null);
	let overlap = $state<Overlap | null>(null);
	let overlapLoading = $state(false);
	let showUnique = $state(false);
	let menuOpen = $state(false); // disconnect overflow
	// What you've shared WITH the selected connection (the management hub).
	let shared = $state<{ peer_id: string | null; spaces: Array<{ id: string; name: string; role: string }>; contexts: Array<{ id: string; name: string; is_private: number }> }>({ peer_id: null, spaces: [], contexts: [] });
	let sharedLoading = $state(false);

	const isEmpty = $derived(connections.length === 0 && pending.length === 0 && sent.length === 0);
	const summary = $derived([
		connections.length ? `${connections.length} connected` : '',
		pending.length ? `${pending.length} request${pending.length > 1 ? 's' : ''}` : '',
		sent.length ? `${sent.length} sent` : '',
	].filter(Boolean).join(' · '));

	// Live refresh: federation events (a new inbound request, or a peer accepting
	// one we sent) are written by the :4711 federation host but surface through the
	// :8787 portal we read — different processes sharing the DB, so we poll rather
	// than push. On each tick we diff against what we'd already seen and toast only
	// genuinely new arrivals (the global toast store shows app-wide, even off this
	// page). `seeded` suppresses toasts for the initial load.
	let seenPending = new Set<string>();
	let seenConns = new Set<string>();
	let seeded = false;

	async function refreshAll() {
		await Promise.all([loadConnections(), loadPending(), loadSent()]);
		if (seeded) {
			for (const r of pending) {
				if (!seenPending.has(r.id)) toasts.info(`@${r.handle} wants to connect`);
			}
			for (const c of connections) {
				if (!seenConns.has(c.id)) toasts.success(`Connected with @${c.other_handle}`);
			}
		}
		seenPending = new Set(pending.map((r) => r.id));
		seenConns = new Set(connections.map((c) => c.id));
		seeded = true;
	}

	$effect(() => {
		if (!browser) return;
		refreshAll();
		// 10s while the page is open — fast enough to feel live for a handshake,
		// cheap enough to poll. Cleared on unmount.
		const t = setInterval(refreshAll, 10000);
		return () => clearInterval(t);
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
			let target = connectHandle.trim().replace(/^@/, '');
			// A bare handle is a mycelium.id handle: "lo" → "lo@lo.mycelium.id" (the
			// domain is always <handle>.mycelium.id, so typing it twice is redundant).
			// Anything already containing "@" is a full federated handle (e.g. a custom
			// domain / another instance) and is sent verbatim.
			if (target && !target.includes('@')) target = `${target}@${target}.mycelium.id`;
			await apiPost('/portal/connections/request', { toHandle: target });
			connectHandle = '';
			composerOpen = false;
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
	// Clear a sent-but-unaccepted invite (e.g. a stranded delivery, or changed mind).
	async function withdrawRequest(id: string) {
		try {
			await apiPost(`/portal/connections/${id}/withdraw`, {});
			sent = sent.filter(s => s.id !== id);
			showSuccess('Invite withdrawn');
		} catch (e: any) { error = e.message || 'Failed to withdraw'; }
	}

	async function disconnectConnection(id: string) {
		if (!confirm('Disconnect? You\'ll lose access to each other\'s shared territories.')) return;
		try {
			const res = await api(`/portal/connections/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed');
			connections = connections.filter(c => c.id !== id);
			selectedConnection = null;
			overlap = null;
			menuOpen = false;
			showSuccess('Disconnected');
		} catch (e: any) { error = e.message; }
	}

	async function viewOverlap(conn: Connection) {
		selectedConnection = conn;
		menuOpen = false;
		showUnique = false;
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
			case 'twin': return 'var(--color-accent-jade)';
			case 'deep-collaborators': return 'var(--color-accent-aurum)';
			case 'broad-kindred': return 'var(--color-accent-amethyst)';
			case 'complementary': return 'var(--color-accent-rose)';
			default: return 'var(--color-text-tertiary)';
		}
	}
	function cachedScore(conn: Connection): number | null {
		try { return conn.overlap_json ? (JSON.parse(conn.overlap_json).matchScore ?? null) : null; } catch { return null; }
	}
</script>

<svelte:head>
	<title>Connections - Mycelium</title>
</svelte:head>

<div class="conn">
	<!-- Header -->
	<header class="conn-top">
		<div class="title-wrap">
			<h1>Connections</h1>
			{#if !isEmpty && summary}<span class="sub">{summary}</span>{/if}
		</div>
		{#if !isEmpty}
			<button class="btn btn-primary" onclick={() => { composerOpen = !composerOpen; connectHandle = ''; }}>
				<span class="plus">+</span> Connect
			</button>
		{/if}
	</header>

	<!-- Connect composer (always shown in the empty state) -->
	{#if composerOpen && !isEmpty}
		<form class="composer glass" onsubmit={(e) => { e.preventDefault(); sendRequest(); }}>
			<input
				type="text" bind:value={connectHandle} autocomplete="off"
				placeholder="their handle  ·  or  name@their-server.org" class="composer-input" />
			<button type="submit" disabled={connecting || !connectHandle.trim()} class="btn btn-primary">
				{connecting ? 'Sending…' : 'Send'}
			</button>
			<button type="button" class="btn btn-ghost" onclick={() => { composerOpen = false; connectHandle = ''; }}>Cancel</button>
		</form>
	{/if}

	{#if loading}
		<div class="loading">Loading connections…</div>

	{:else if isEmpty}
		<!-- Onboarding only when there's nothing yet -->
		<div class="onboard glass">
			<h2 class="onboard-title">Where your mind meets others'</h2>
			<p class="onboard-lede">Link with anyone on Mycelium to see where your minds overlap — shared territories, kindred realms — and selectively share a space or a facet. Nothing leaves your vault until you choose it.</p>
			<div class="steps">
				<div class="step"><span class="step-n">1</span><span class="step-t">Send a request — just their handle (e.g. <code>lo</code>), or <code>name@their-server.org</code> for a custom domain.</span></div>
				<div class="step"><span class="step-n">2</span><span class="step-t">They accept — a private, signed link forms between your vaults, revocable anytime.</span></div>
				<div class="step"><span class="step-n">3</span><span class="step-t">Compare your overlap, then grant a space or a mindscape facet — only what you pick.</span></div>
			</div>
			<form class="composer onboard-composer" onsubmit={(e) => { e.preventDefault(); sendRequest(); }}>
				<input
					type="text" bind:value={connectHandle} autocomplete="off"
					placeholder="their handle  ·  or  name@their-server.org" class="composer-input" />
				<button type="submit" disabled={connecting || !connectHandle.trim()} class="btn btn-primary">
					{connecting ? 'Sending…' : 'Connect'}
				</button>
			</form>
		</div>

	{:else}
		<!-- Two-pane workspace -->
		<div class="panes">
			<!-- Left: unified people list -->
			<aside class="list">
				{#each pending as req (req.id)}
					<div class="row request">
						<div class="who">
							{#if req.avatar_url}<img src={req.avatar_url} alt="" class="avatar" />{:else}<div class="avatar ph">@</div>{/if}
							<div class="who-text">
								<span class="handle">@{req.handle}</span>
								<span class="meta">wants to connect</span>
							</div>
						</div>
						{#if req.signature}<p class="row-sig">"{req.signature}"</p>{/if}
						<div class="row-actions">
							<button class="btn btn-primary btn-xs" onclick={() => acceptRequest(req.id)}>Accept</button>
							<button class="btn btn-ghost btn-xs" onclick={() => rejectRequest(req.id)}>Ignore</button>
						</div>
					</div>
				{/each}

				{#each connections as conn (conn.id)}
					{@const score = cachedScore(conn)}
					<button class="row conn-row" class:selected={selectedConnection?.id === conn.id} onclick={() => viewOverlap(conn)}>
						<div class="who">
							{#if conn.other_avatar_url}<img src={conn.other_avatar_url} alt="" class="avatar" />{:else}<div class="avatar ph">@</div>{/if}
							<div class="who-text"><span class="handle">@{conn.other_handle}</span></div>
							{#if score != null}<span class="score">{score}%</span>{/if}
						</div>
					</button>
				{/each}

				{#each sent as s (s.id)}
					<div class="row sent">
						<div class="who">
							<div class="avatar ph muted">⋯</div>
							<div class="who-text">
								<span class="handle muted">@{s.to_handle || '?'}</span>
								<span class="meta">invite sent</span>
							</div>
							<button class="link-revoke" onclick={() => withdrawRequest(s.id)}>Withdraw</button>
						</div>
					</div>
				{/each}
			</aside>

			<!-- Right: detail pane -->
			<section class="detail">
				{#if !selectedConnection}
					<div class="detail-empty">
						<p>Select a connection to see where your minds overlap.</p>
					</div>
				{:else}
					<button class="detail-back" onclick={() => { selectedConnection = null; }}>← All connections</button>

					<div class="detail-hero">
						{#if selectedConnection.other_avatar_url}<img src={selectedConnection.other_avatar_url} alt="" class="avatar lg" />{:else}<div class="avatar lg ph">@</div>{/if}
						<div class="hero-text">
							<span class="hero-handle">@{selectedConnection.other_handle}</span>
							{#if selectedConnection.other_signature}<span class="hero-sig">"{selectedConnection.other_signature}"</span>{/if}
						</div>
						<div class="menu-wrap">
							<button class="icon-btn" aria-label="More" onclick={() => menuOpen = !menuOpen}>⋯</button>
							{#if menuOpen}
								<div class="menu">
									<button class="menu-item danger" onclick={() => selectedConnection && disconnectConnection(selectedConnection.id)}>Disconnect</button>
								</div>
							{/if}
						</div>
					</div>

					{#if overlapLoading}
						<div class="loading">Computing overlap…</div>
					{:else if overlap}
						<div class="summary-row">
							{#if overlap.matchScore != null}
								<span class="score-hero">{overlap.matchScore}%</span>
							{:else}
								<span class="score-na">Not enough overlap to score</span>
							{/if}
							{#if overlap.shapeLabel}<span class="shape-chip" style="color: {shapeColor(overlap.shape)}; border-color: {shapeColor(overlap.shape)}">{overlap.shapeLabel}</span>{/if}
							<span class="summary-count">{overlap.sharedCount} shared</span>
						</div>

						{#if overlap.shared.length > 0}
							<div class="block">
								<h3>Where you overlap</h3>
								{#each overlap.shared as t}
									{@const maxDepth = Math.max(t.my_depth, t.their_depth, 1)}
									<div class="terr">
										<div class="terr-name">{t.name}</div>
										<div class="bars">
											<div class="bar-track"><div class="bar you" style="width: {t.my_depth / maxDepth * 100}%"></div></div>
											<div class="bar-track"><div class="bar them" style="width: {t.their_depth / maxDepth * 100}%"></div></div>
										</div>
									</div>
								{/each}
								<div class="legend">
									<span><i class="sw you"></i>you</span>
									<span><i class="sw them"></i>@{selectedConnection.other_handle}</span>
									{#if overlap.myOnly.length || overlap.theirOnly.length}
										<button class="legend-toggle" onclick={() => showUnique = !showUnique}>
											{showUnique ? 'Hide' : `${overlap.myOnly.length + overlap.theirOnly.length} only-yours/theirs`} ›
										</button>
									{/if}
								</div>
							</div>
						{/if}

						{#if showUnique}
							{#if overlap.myOnly.length > 0}
								<div class="block"><h3>Only you</h3>
									<div class="tags">{#each overlap.myOnly as t}<span class="tag" title={t.essence}>{t.name}</span>{/each}</div>
								</div>
							{/if}
							{#if overlap.theirOnly.length > 0}
								<div class="block"><h3>Only @{selectedConnection.other_handle}</h3>
									<div class="tags">{#each overlap.theirOnly as t}<span class="tag" title={t.essence}>{t.name}</span>{/each}</div>
								</div>
							{/if}
						{/if}
					{/if}

					<!-- Shared-with management — promoted, not buried -->
					<div class="block shared-card">
						<div class="shared-head">
							<h3>Shared with @{selectedConnection.other_handle}</h3>
							<button class="btn btn-ghost btn-xs" onclick={() => workspace.openOrFocus('contexts')}>
								<span class="plus">+</span> Share
							</button>
						</div>
						{#if sharedLoading}
							<div class="loading sm">Loading…</div>
						{:else if shared.spaces.length === 0 && shared.contexts.length === 0}
							<p class="shared-empty">Nothing shared yet. Grant a space (Spaces → a space → Members) or a mindscape facet (Sharing).</p>
						{:else}
							{#each shared.spaces as s (s.id)}
								<div class="shared-row">
									<span class="shared-label">{s.name} <span class="shared-role">· {s.role === 'contributor' ? 'can add' : 'can view'}</span></span>
									<button class="link-revoke" onclick={() => revokeSpaceShare(s.id)}>Revoke</button>
								</div>
							{/each}
							{#each shared.contexts as c (c.id)}
								<div class="shared-row">
									<span class="shared-label">{c.name} <span class="shared-role">· facet</span></span>
									<button class="link-revoke" onclick={() => revokeContextGrant(c.id)}>Revoke</button>
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			</section>
		</div>
	{/if}

	{#if error}<button type="button" class="toast error" onclick={() => error = null}>{error}</button>{/if}
	{#if success}<div class="toast success">{success}</div>{/if}
</div>

<style>
	.conn { padding: 1.5rem 2rem; max-width: 1000px; margin: 0 auto; height: 100%; display: flex; flex-direction: column; overflow: hidden; }

	.glass {
		background: var(--glass-card-bg); border: 1px solid var(--glass-border); border-radius: 14px;
		backdrop-filter: blur(12px) saturate(130%); -webkit-backdrop-filter: blur(12px) saturate(130%);
	}

	/* Header */
	.conn-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; flex-shrink: 0; }
	.title-wrap { display: flex; align-items: baseline; gap: 0.75rem; min-width: 0; }
	.conn-top h1 { font-size: 1.35rem; font-weight: 400; letter-spacing: -0.01em; color: var(--color-text-primary); }
	.sub { font-size: 0.78rem; color: var(--color-text-tertiary); }
	.plus { font-weight: 400; opacity: 0.85; }

	/* Composer */
	.composer { display: flex; gap: 0.5rem; align-items: center; padding: 0.6rem 0.7rem; margin-bottom: 1rem; flex-shrink: 0; }
	.composer-input {
		flex: 1; min-width: 0; padding: 0.5rem 0.75rem; font-family: var(--font-mono); font-size: 0.82rem;
		background: var(--glass-input-bg); border: 1px solid var(--glass-input-border); border-radius: 8px;
		color: var(--color-text-primary); outline: none;
	}
	.composer-input::placeholder { color: var(--color-text-tertiary); }
	.composer-input:focus { border-color: var(--color-accent-aurum); }

	/* Onboarding (empty state) */
	.onboard { padding: 2rem; max-width: 620px; margin: 1rem auto; }
	.onboard-title { font-size: 1.4rem; font-weight: 400; color: var(--color-text-primary); margin-bottom: 0.6rem; }
	.onboard-lede { font-size: 0.88rem; line-height: 1.6; color: var(--color-text-secondary); margin-bottom: 1.5rem; }
	.steps { display: flex; flex-direction: column; gap: 0.85rem; margin-bottom: 1.5rem; }
	.step { display: flex; align-items: flex-start; gap: 0.75rem; }
	.step-n {
		flex-shrink: 0; width: 1.4rem; height: 1.4rem; border-radius: 50%; display: inline-flex; align-items: center;
		justify-content: center; font-family: var(--font-mono); font-size: 0.7rem;
		background: rgba(var(--color-accent-aurum-rgb), 0.14); color: var(--color-accent-aurum);
	}
	.step-t { font-size: 0.82rem; line-height: 1.5; color: var(--color-text-secondary); }
	.onboard-composer { padding: 0; border: none; background: none; backdrop-filter: none; -webkit-backdrop-filter: none; margin: 0; }
	code { font-family: var(--font-mono); font-size: 0.92em; color: var(--color-text-primary); background: var(--glass-input-bg); padding: 0.5px 5px; border-radius: 4px; }

	/* Two-pane */
	.panes { display: grid; grid-template-columns: 280px 1fr; gap: 1rem; flex: 1; min-height: 0; }
	.list { display: flex; flex-direction: column; gap: 0.4rem; overflow-y: auto; padding-right: 0.25rem; }
	.detail { overflow-y: auto; padding: 0 0.25rem; }

	/* List rows */
	.row { background: var(--color-surface); border: 1px solid var(--glass-border); border-radius: 12px; padding: 0.7rem 0.8rem; text-align: left; width: 100%; }
	.who { display: flex; align-items: center; gap: 0.6rem; }
	.who-text { display: flex; flex-direction: column; min-width: 0; gap: 0.05rem; }
	.avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid var(--color-border); flex-shrink: 0; }
	.avatar.lg { width: 44px; height: 44px; }
	.avatar.ph { background: var(--color-elevated); display: flex; align-items: center; justify-content: center; font-size: 0.8rem; color: var(--color-text-tertiary); }
	.avatar.ph.muted { font-size: 0.9rem; }
	.handle { font-weight: 600; font-size: 0.86rem; color: var(--color-text-emphasis); }
	.handle.muted, .muted { color: var(--color-text-tertiary); }
	.meta { font-size: 0.68rem; color: var(--color-text-tertiary); }
	.score { margin-left: auto; font-family: var(--font-mono); font-size: 0.74rem; color: var(--color-text-secondary); }
	.row-sig { font-size: 0.74rem; color: var(--color-text-secondary); margin: 0.45rem 0 0; }

	.request { border-color: rgba(var(--color-accent-aurum-rgb), 0.35); background: rgba(var(--color-accent-aurum-rgb), 0.06); }
	.row-actions { display: flex; gap: 0.4rem; margin-top: 0.55rem; }
	.row-actions .btn { flex: 1; }

	.conn-row { cursor: pointer; transition: border-color 0.15s, background 0.15s; font-family: inherit; color: inherit; }
	.conn-row:hover { border-color: var(--color-accent-aurum); }
	.conn-row.selected { border-color: var(--color-accent-aurum); background: rgba(var(--color-accent-aurum-rgb), 0.06); }

	.sent { opacity: 0.92; }
	.link-revoke { margin-left: auto; font-size: 0.7rem; color: var(--color-text-tertiary); background: none; border: none; cursor: pointer; flex-shrink: 0; }
	.link-revoke:hover { color: var(--color-accent-coral); }

	/* Detail pane */
	.detail-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--color-text-tertiary); font-size: 0.85rem; text-align: center; padding: 2rem; }
	.detail-back { display: none; background: none; border: none; color: var(--color-text-tertiary); font-size: 0.78rem; cursor: pointer; margin-bottom: 0.75rem; padding: 0; }
	.detail-hero { display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 1rem; }
	.hero-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
	.hero-handle { font-size: 1.05rem; font-weight: 600; color: var(--color-text-emphasis); }
	.hero-sig { font-size: 0.8rem; color: var(--color-text-secondary); font-style: italic; }
	.menu-wrap { position: relative; flex-shrink: 0; }
	.icon-btn { background: none; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-tertiary); cursor: pointer; padding: 0.2rem 0.5rem; font-size: 0.9rem; line-height: 1; }
	.icon-btn:hover { color: var(--color-text-secondary); border-color: var(--color-text-tertiary); }
	.menu { position: absolute; right: 0; top: 110%; background: var(--color-elevated); border: 1px solid var(--glass-border); border-radius: 8px; padding: 0.25rem; z-index: 20; min-width: 130px; }
	.menu-item { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0.4rem 0.6rem; font-size: 0.78rem; border-radius: 6px; cursor: pointer; color: var(--color-text-secondary); }
	.menu-item:hover { background: var(--color-surface); }
	.menu-item.danger { color: var(--color-accent-coral); }

	.summary-row { display: flex; align-items: center; gap: 0.7rem; padding: 0.85rem 0; border-top: 1px solid var(--color-border); border-bottom: 1px solid var(--color-border); margin-bottom: 1.25rem; }
	.score-hero { font-size: 1.9rem; font-weight: 700; font-family: var(--font-mono); color: var(--color-accent-aurum); line-height: 1; }
	.score-na { font-size: 0.82rem; color: var(--color-text-tertiary); }
	.shape-chip { font-size: 0.72rem; padding: 0.15rem 0.6rem; border: 1px solid; border-radius: 999px; }
	.summary-count { margin-left: auto; font-size: 0.74rem; color: var(--color-text-tertiary); }

	.block { margin-bottom: 1.4rem; }
	.block h3 { font-family: var(--font-mono); font-size: 0.62rem; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-tertiary); margin-bottom: 0.7rem; }

	.terr { margin-bottom: 0.7rem; }
	.terr-name { font-size: 0.82rem; color: var(--color-text-primary); margin-bottom: 0.3rem; }
	.bars { display: flex; flex-direction: column; gap: 0.2rem; }
	.bar-track { height: 5px; background: var(--color-elevated); border-radius: 3px; overflow: hidden; }
	.bar { height: 100%; border-radius: 3px; }
	.bar.you { background: var(--color-accent-aurum); }
	.bar.them { background: var(--color-accent); }
	.legend { display: flex; align-items: center; gap: 1rem; margin-top: 0.6rem; font-size: 0.7rem; color: var(--color-text-tertiary); }
	.legend .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 0.35rem; }
	.legend .sw.you { background: var(--color-accent-aurum); }
	.legend .sw.them { background: var(--color-accent); }
	.legend-toggle { margin-left: auto; background: none; border: none; color: var(--color-accent); font-size: 0.7rem; cursor: pointer; }

	.tags { display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.tag { font-size: 0.72rem; padding: 0.2rem 0.5rem; background: var(--color-elevated); border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-secondary); }

	.shared-card { border-top: 1px solid var(--color-border); padding-top: 1.1rem; }
	.shared-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
	.shared-head h3 { margin-bottom: 0; }
	.shared-empty { font-size: 0.78rem; color: var(--color-text-tertiary); }
	.shared-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.35rem 0; }
	.shared-label { font-size: 0.82rem; color: var(--color-text-primary); }
	.shared-role { color: var(--color-text-tertiary); font-size: 0.74rem; }

	/* Buttons */
	.btn { padding: 0.4rem 0.8rem; font-size: 0.78rem; font-family: var(--font-sans); border-radius: 7px; cursor: pointer; border: none; transition: all 0.15s; white-space: nowrap; }
	.btn-xs { padding: 0.3rem 0.6rem; font-size: 0.72rem; }
	.btn-primary { background: var(--color-accent-aurum); color: var(--color-bg); font-weight: 500; }
	.btn-primary:hover { opacity: 0.9; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); }
	.btn-ghost:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }

	.loading { text-align: center; padding: 2rem; color: var(--color-text-tertiary); font-size: 0.82rem; }
	.loading.sm { padding: 0.75rem; text-align: left; }

	.toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); padding: 0.5rem 1.25rem; border-radius: 8px; font-size: 0.78rem; z-index: 100; border: none; font-family: var(--font-sans); }
	.toast.error { background: rgba(var(--color-accent-coral-rgb), 0.15); border: 1px solid rgba(var(--color-accent-coral-rgb), 0.3); color: var(--color-accent-coral); cursor: pointer; }
	.toast.success { background: rgba(var(--color-accent-jade-rgb), 0.15); border: 1px solid rgba(var(--color-accent-jade-rgb), 0.3); color: var(--color-accent-jade); }

	/* Narrow: stack to one column; show the selected detail with a back button. */
	@media (max-width: 720px) {
		.panes { grid-template-columns: 1fr; }
		.detail-back { display: block; }
	}
</style>
