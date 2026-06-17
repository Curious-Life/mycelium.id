<script lang="ts">
	import { browser } from '$app/environment';
	import { tick } from 'svelte';
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
		remote_instance?: string | null;
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

	interface PeerMessage {
		id: string;
		direction: 'in' | 'out';
		content: string;
		status: string;
		read: number;
		created_at: string;
	}

	let connections = $state<Connection[]>([]);
	let pending = $state<PendingRequest[]>([]);
	let sent = $state<SentRequest[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);
	let query = $state('');

	// Connect composer
	let composerOpen = $state(false);
	let connectHandle = $state('');
	let connecting = $state(false);

	// Detail pane
	let selectedConnection = $state<Connection | null>(null);
	let tab = $state<'chat' | 'overlap' | 'shared'>('chat');
	let menuOpen = $state(false);

	// Conversation
	let messages = $state<PeerMessage[]>([]);
	let messagesLoading = $state(false);
	let draft = $state('');
	let sending = $state(false);
	let threadEl = $state<HTMLElement | null>(null);
	let unread = $state<{ total: number; byConnection: Record<string, number> }>({ total: 0, byConnection: {} });

	// Overlap + sharing
	let overlap = $state<Overlap | null>(null);
	let overlapLoading = $state(false);
	let showUnique = $state(false);
	let shared = $state<{ peer_id: string | null; spaces: Array<{ id: string; name: string; role: string }>; contexts: Array<{ id: string; name: string; is_private: number }>; inbound: Array<{ id: string; kind: string; name: string | null; role: string | null; granted_at: string | null }> }>({ peer_id: null, spaces: [], contexts: [], inbound: [] });
	let sharedLoading = $state(false);

	const isEmpty = $derived(connections.length === 0 && pending.length === 0 && sent.length === 0);
	const filtered = $derived(
		query.trim()
			? connections.filter((c) => `${c.other_handle} ${c.other_display_name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
			: connections,
	);

	// ── helpers ──────────────────────────────────────────────────────────────
	function displayName(c: { other_display_name?: string | null; other_handle?: string; handle?: string; to_handle?: string | null; display_name?: string | null }): string {
		return (c.other_display_name || c.display_name || '')?.split('@')[0]?.trim()
			|| c.other_handle || (c as any).handle || (c as any).to_handle || 'unknown';
	}
	function avatarSeed(s: string): { bg: string; fg: string; initials: string } {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
		const hue = h % 360;
		const hue2 = (hue + 38) % 360;
		const initials = (s.replace(/^@/, '').replace(/@.*$/, '').slice(0, 2) || '·').toUpperCase();
		return { bg: `linear-gradient(135deg, hsl(${hue} 52% 46%), hsl(${hue2} 56% 38%))`, fg: '#fff', initials };
	}
	function instanceOf(c: Connection): string | null {
		const fromName = c.other_display_name && c.other_display_name.includes('@') ? c.other_display_name.split('@')[1] : null;
		return fromName || c.remote_instance || null;
	}
	function fmtTime(iso: string): string {
		try {
			const d = new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
			const now = new Date();
			const sameDay = d.toDateString() === now.toDateString();
			if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
			const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
			if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
			return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
		} catch { return ''; }
	}
	function cachedScore(conn: Connection): number | null {
		try { return conn.overlap_json ? (JSON.parse(conn.overlap_json).matchScore ?? null) : null; } catch { return null; }
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
	function showSuccess(msg: string) { success = msg; setTimeout(() => (success = null), 3000); }

	// ── data load ────────────────────────────────────────────────────────────
	let seenPending = new Set<string>();
	let seenConns = new Set<string>();
	let seeded = false;

	async function refreshAll() {
		await Promise.all([loadConnections(), loadPending(), loadSent(), loadUnread()]);
		if (seeded) {
			for (const r of pending) if (!seenPending.has(r.id)) toasts.info(`@${r.handle} wants to connect`);
			for (const c of connections) if (!seenConns.has(c.id)) toasts.success(`Connected with @${c.other_handle}`);
		}
		seenPending = new Set(pending.map((r) => r.id));
		seenConns = new Set(connections.map((c) => c.id));
		seeded = true;
	}

	$effect(() => {
		if (!browser) return;
		refreshAll();
		const t = setInterval(refreshAll, 10000);
		return () => clearInterval(t);
	});

	// Poll the open conversation for new inbound messages (different process writes
	// them via the federation host) + keep it marked read.
	$effect(() => {
		if (!browser || !selectedConnection || tab !== 'chat') return;
		const id = selectedConnection.id;
		const t = setInterval(() => loadMessages(id, true), 5000);
		return () => clearInterval(t);
	});

	async function loadConnections() {
		try { connections = (await apiGet<{ connections: Connection[] }>('/portal/connections')).connections; }
		catch {} finally { loading = false; }
	}
	async function loadPending() {
		try { pending = (await apiGet<{ requests: PendingRequest[] }>('/portal/connections/pending')).requests; } catch {}
	}
	async function loadSent() {
		try { sent = (await apiGet<{ sent: SentRequest[] }>('/portal/connections/sent')).sent; } catch {}
	}
	async function loadUnread() {
		try { unread = await apiGet('/portal/connections/messages/unread'); } catch {}
	}

	async function sendRequest() {
		if (!connectHandle.trim()) return;
		connecting = true; error = null;
		try {
			let target = connectHandle.trim().replace(/^@/, '');
			if (target && !target.includes('@')) target = `${target}@${target}.mycelium.id`;
			await apiPost('/portal/connections/request', { toHandle: target });
			connectHandle = ''; composerOpen = false;
			showSuccess('Request sent'); loadSent();
		} catch (e: any) { error = e.message || 'Failed to send request'; }
		finally { connecting = false; }
	}

	async function acceptRequest(id: string) {
		try { await apiPost(`/portal/connections/${id}/accept`, {}); pending = pending.filter((r) => r.id !== id); await loadConnections(); showSuccess('Connected'); }
		catch (e: any) { error = e.message; }
	}
	async function rejectRequest(id: string) {
		try { await apiPost(`/portal/connections/${id}/reject`, {}); pending = pending.filter((r) => r.id !== id); }
		catch (e: any) { error = e.message; }
	}
	async function withdrawRequest(id: string) {
		try { await apiPost(`/portal/connections/${id}/withdraw`, {}); sent = sent.filter((s) => s.id !== id); showSuccess('Invite withdrawn'); }
		catch (e: any) { error = e.message || 'Failed to withdraw'; }
	}
	async function disconnectConnection(id: string) {
		if (!confirm("Disconnect? You'll lose access to each other's shared territories and conversation.")) return;
		try {
			const res = await api(`/portal/connections/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('Failed');
			connections = connections.filter((c) => c.id !== id);
			selectedConnection = null; overlap = null; menuOpen = false; messages = [];
			showSuccess('Disconnected');
		} catch (e: any) { error = e.message; }
	}

	// ── conversation ─────────────────────────────────────────────────────────
	async function selectConnection(conn: Connection) {
		selectedConnection = conn; tab = 'chat'; menuOpen = false; showUnique = false;
		overlap = null; messages = [];
		loadMessages(conn.id);
	}

	async function loadMessages(connId: string, silent = false) {
		if (!silent) messagesLoading = true;
		try {
			const data = await apiGet<{ messages: PeerMessage[] }>(`/portal/connections/${connId}/messages`);
			// only mutate if still viewing this connection
			if (selectedConnection?.id !== connId) return;
			const grew = data.messages.length !== messages.length;
			messages = data.messages;
			if (grew) { await tick(); scrollToEnd(); }
			// mark read + clear the badge
			if (unread.byConnection[connId]) {
				await apiPost(`/portal/connections/${connId}/messages/read`, {});
				const { [connId]: _, ...rest } = unread.byConnection;
				unread = { total: Math.max(0, unread.total - (unread.byConnection[connId] || 0)), byConnection: rest };
			}
		} catch {} finally { if (!silent) messagesLoading = false; }
	}

	function scrollToEnd() { if (threadEl) threadEl.scrollTop = threadEl.scrollHeight; }

	async function sendMessage() {
		const text = draft.trim();
		if (!text || !selectedConnection || sending) return;
		sending = true;
		const connId = selectedConnection.id;
		// optimistic
		const optimistic: PeerMessage = { id: `tmp-${Date.now()}`, direction: 'out', content: text, status: 'sending', read: 1, created_at: new Date().toISOString() };
		messages = [...messages, optimistic];
		draft = '';
		await tick(); scrollToEnd();
		try {
			const r = await apiPost<{ message: { id: string; status: string } }>(`/portal/connections/${connId}/messages`, { text });
			if (selectedConnection?.id === connId) {
				messages = messages.map((m) => (m.id === optimistic.id ? { ...m, id: r.message.id, status: r.message.status } : m));
			}
		} catch (e: any) {
			messages = messages.map((m) => (m.id === optimistic.id ? { ...m, status: 'failed' } : m));
			error = e.message || 'Failed to send';
		} finally { sending = false; }
	}

	function onComposerKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
	}

	// ── overlap + sharing (lazy, on tab open) ──────────────────────────────────
	$effect(() => {
		if (tab === 'overlap' && selectedConnection && !overlap && !overlapLoading) loadOverlap(selectedConnection);
		if (tab === 'shared' && selectedConnection) loadShared(selectedConnection.id);
	});
	async function loadOverlap(conn: Connection) {
		overlapLoading = true; overlap = null;
		try { overlap = (await apiGet<{ overlap: Overlap }>(`/portal/connections/${conn.id}/overlap`)).overlap; }
		catch (e: any) { error = e.message || 'Failed to compute overlap'; }
		finally { overlapLoading = false; }
	}
	async function loadShared(connId: string) {
		sharedLoading = true; shared = { peer_id: null, spaces: [], contexts: [], inbound: [] };
		try { shared = await apiGet(`/portal/connections/${connId}/shared`); } catch {} finally { sharedLoading = false; }
		// Opening the Shared view clears the "new share" part of the People badge.
		try { await apiPost('/portal/inbound-shares/seen', {}); } catch {}
	}
	// Read-only viewer for a share a peer granted me. Fetches the contents from
	// THEIR instance (signed + grant-gated + signature-verified on the server).
	let viewing = $state<{ id: string; kind: string; name: string | null } | null>(null);
	let shareContent = $state<any | null>(null);
	let shareContentLoading = $state(false);
	let shareContentError = $state<string | null>(null);
	async function openInboundShare(item: { id: string; kind: string; name: string | null }) {
		if (!selectedConnection) return;
		viewing = item; shareContent = null; shareContentError = null; shareContentLoading = true;
		try {
			const r = await apiGet<{ content: any }>(`/portal/connections/${selectedConnection.id}/shared/${item.id}/contents`);
			shareContent = r.content;
		} catch (e: any) {
			shareContentError = e.message || 'Could not load — the share may have been revoked, or their instance is offline.';
		} finally { shareContentLoading = false; }
	}
	function closeShareViewer() { viewing = null; shareContent = null; shareContentError = null; }
	async function revokeSpaceShare(spaceId: string) {
		if (!shared.peer_id) return;
		try { await api(`/portal/spaces/${spaceId}/shares/${encodeURIComponent(shared.peer_id)}`, { method: 'DELETE' }); if (selectedConnection) await loadShared(selectedConnection.id); showSuccess('Space access revoked'); }
		catch (e: any) { error = e.message || 'Failed to revoke'; }
	}
	async function revokeContextGrant(contextId: string) {
		if (!selectedConnection) return;
		try { await api(`/portal/contexts/${contextId}/grant/${encodeURIComponent(selectedConnection.id)}`, { method: 'DELETE' }); await loadShared(selectedConnection.id); showSuccess('Sharing revoked'); }
		catch (e: any) { error = e.message || 'Failed to revoke'; }
	}
</script>

<svelte:head><title>People · Mycelium</title></svelte:head>

<div class="people">
	{#if loading}
		<div class="loading">Loading people…</div>

	{:else if isEmpty}
		<!-- Empty / onboarding -->
		<div class="onboard">
			<div class="onboard-card glass">
				<div class="orbit" aria-hidden="true"><span class="orbit-dot"></span></div>
				<h2>Where your mind meets others'</h2>
				<p class="lede">Connect with anyone on Mycelium to message them directly, see where your minds overlap, and selectively share a space or a facet. Everything is signed between your vaults — nothing leaves until you choose it.</p>
				<form class="big-composer" onsubmit={(e) => { e.preventDefault(); sendRequest(); }}>
					<input type="text" bind:value={connectHandle} autocomplete="off" placeholder="their handle  ·  or  name@their-server.org" />
					<button type="submit" disabled={connecting || !connectHandle.trim()} class="btn btn-primary">{connecting ? 'Sending…' : 'Connect'}</button>
				</form>
				<p class="hint">A bare handle like <code>lo</code> resolves to <code>lo.mycelium.id</code>. Use <code>name@server.org</code> for a custom domain.</p>
			</div>
		</div>

	{:else}
		<!-- Two-pane hub -->
		<div class="hub">
			<!-- Sidebar -->
			<aside class="sidebar">
				<div class="sb-top">
					<h1>People</h1>
					<button class="btn btn-primary btn-sm" onclick={() => { composerOpen = !composerOpen; connectHandle = ''; }}>＋ Connect</button>
				</div>

				{#if composerOpen}
					<form class="inline-composer" onsubmit={(e) => { e.preventDefault(); sendRequest(); }}>
						<input type="text" bind:value={connectHandle} autocomplete="off" placeholder="handle · name@server.org" />
						<button type="submit" disabled={connecting || !connectHandle.trim()} class="btn btn-primary btn-sm">{connecting ? '…' : 'Send'}</button>
					</form>
				{/if}

				{#if connections.length > 3}
					<input class="search" type="text" bind:value={query} placeholder="Search people" />
				{/if}

				<div class="sb-scroll">
					{#if pending.length}
						<div class="sb-label">Requests</div>
						{#each pending as req (req.id)}
							{@const a = avatarSeed(req.handle)}
							<div class="req-card">
								<div class="req-who">
									<div class="avatar" style="background:{a.bg};color:{a.fg}">{a.initials}</div>
									<div class="who-text">
										<span class="name">@{req.handle}</span>
										<span class="meta">wants to connect</span>
									</div>
								</div>
								{#if req.signature}<p class="req-sig">“{req.signature}”</p>{/if}
								<div class="req-actions">
									<button class="btn btn-primary btn-xs" onclick={() => acceptRequest(req.id)}>Accept</button>
									<button class="btn btn-ghost btn-xs" onclick={() => rejectRequest(req.id)}>Ignore</button>
								</div>
							</div>
						{/each}
					{/if}

					{#if filtered.length}
						<div class="sb-label">People</div>
						{#each filtered as conn (conn.id)}
							{@const a = avatarSeed(conn.other_handle)}
							{@const n = unread.byConnection[conn.id] || 0}
							<button class="person" class:selected={selectedConnection?.id === conn.id} onclick={() => selectConnection(conn)}>
								<div class="avatar" style="background:{a.bg};color:{a.fg}">{a.initials}</div>
								<div class="person-body">
									<div class="person-line1">
										<span class="name">{displayName(conn)}</span>
										{#if n > 0}<span class="unread">{n}</span>{/if}
									</div>
									<div class="person-line2">
										<span class="handle">@{conn.other_handle}</span>
										{#if cachedScore(conn) != null}<span class="dot">·</span><span class="score">{cachedScore(conn)}% overlap</span>{/if}
									</div>
								</div>
							</button>
						{/each}
					{/if}

					{#if sent.length}
						<div class="sb-label">Invited</div>
						{#each sent as s (s.id)}
							{@const a = avatarSeed(s.to_handle || '?')}
							<div class="person invited">
								<div class="avatar muted" style="background:{a.bg};opacity:.5">{a.initials}</div>
								<div class="person-body">
									<div class="person-line1"><span class="name muted">@{s.to_handle || '?'}</span></div>
									<div class="person-line2"><span class="meta">invite sent</span></div>
								</div>
								<button class="link-revoke" onclick={() => withdrawRequest(s.id)}>Withdraw</button>
							</div>
						{/each}
					{/if}
				</div>
			</aside>

			<!-- Main -->
			<section class="main">
				{#if !selectedConnection}
					<div class="main-empty">
						<div class="empty-glyph" aria-hidden="true">✦</div>
						<p>Select someone to start a conversation, or compare where your minds overlap.</p>
					</div>
				{:else}
					{@const a = avatarSeed(selectedConnection.other_handle)}
					<header class="convo-head">
						<button class="back" onclick={() => (selectedConnection = null)} aria-label="Back">←</button>
						<div class="avatar" style="background:{a.bg};color:{a.fg}">{a.initials}</div>
						<div class="head-text">
							<span class="head-name">{displayName(selectedConnection)}</span>
							<span class="head-sub">@{selectedConnection.other_handle}{#if instanceOf(selectedConnection)} · <span class="instance">{instanceOf(selectedConnection)}</span>{/if}</span>
						</div>
						<nav class="tabs">
							<button class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
							<button class:active={tab === 'overlap'} onclick={() => (tab = 'overlap')}>Overlap</button>
							<button class:active={tab === 'shared'} onclick={() => (tab = 'shared')}>Shared</button>
						</nav>
						<div class="menu-wrap">
							<button class="icon-btn" aria-label="More" onclick={() => (menuOpen = !menuOpen)}>⋯</button>
							{#if menuOpen}
								<div class="menu">
									<button class="menu-item danger" onclick={() => selectedConnection && disconnectConnection(selectedConnection.id)}>Disconnect</button>
								</div>
							{/if}
						</div>
					</header>

					{#if tab === 'chat'}
						<div class="thread" bind:this={threadEl}>
							{#if messagesLoading && messages.length === 0}
								<div class="loading sm">Loading…</div>
							{:else if messages.length === 0}
								<div class="thread-empty">
									<p>This is the start of your conversation with <strong>{displayName(selectedConnection)}</strong>.</p>
									<p class="muted">Messages are signed and sent directly between your two instances.</p>
								</div>
							{:else}
								{#each messages as m (m.id)}
									<div class="bubble-row {m.direction}">
										<div class="bubble {m.direction}" class:failed={m.status === 'failed'}>
											<span class="bubble-text">{m.content}</span>
											<span class="bubble-meta">
												{fmtTime(m.created_at)}
												{#if m.direction === 'out'}
													{#if m.status === 'sending'}· sending{:else if m.status === 'delivered'}· delivered{:else if m.status === 'failed'}· failed{:else}· sent{/if}
												{/if}
											</span>
										</div>
									</div>
								{/each}
							{/if}
						</div>
						<form class="compose" onsubmit={(e) => { e.preventDefault(); sendMessage(); }}>
							<textarea bind:value={draft} onkeydown={onComposerKey} rows="1" placeholder={`Message ${displayName(selectedConnection)}…`}></textarea>
							<button type="submit" class="send" disabled={!draft.trim() || sending} aria-label="Send">↑</button>
						</form>

					{:else if tab === 'overlap'}
						<div class="pane-scroll">
							{#if overlapLoading}
								<div class="loading">Computing overlap…</div>
							{:else if overlap}
								<div class="summary-row">
									{#if overlap.matchScore != null}<span class="score-hero">{overlap.matchScore}%</span>{:else}<span class="score-na">Not enough overlap to score yet</span>{/if}
									{#if overlap.shapeLabel}<span class="shape-chip" style="color:{shapeColor(overlap.shape)};border-color:{shapeColor(overlap.shape)}">{overlap.shapeLabel}</span>{/if}
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
													<div class="bar-track"><div class="bar you" style="width:{(t.my_depth / maxDepth) * 100}%"></div></div>
													<div class="bar-track"><div class="bar them" style="width:{(t.their_depth / maxDepth) * 100}%"></div></div>
												</div>
											</div>
										{/each}
										<div class="legend">
											<span><i class="sw you"></i>you</span>
											<span><i class="sw them"></i>@{selectedConnection.other_handle}</span>
											{#if overlap.myOnly.length || overlap.theirOnly.length}
												<button class="legend-toggle" onclick={() => (showUnique = !showUnique)}>{showUnique ? 'Hide' : `${overlap.myOnly.length + overlap.theirOnly.length} only-yours/theirs`} ›</button>
											{/if}
										</div>
									</div>
								{/if}
								{#if showUnique}
									{#if overlap.myOnly.length > 0}<div class="block"><h3>Only you</h3><div class="tags">{#each overlap.myOnly as t}<span class="tag" title={t.essence}>{t.name}</span>{/each}</div></div>{/if}
									{#if overlap.theirOnly.length > 0}<div class="block"><h3>Only @{selectedConnection.other_handle}</h3><div class="tags">{#each overlap.theirOnly as t}<span class="tag" title={t.essence}>{t.name}</span>{/each}</div></div>{/if}
								{/if}
							{/if}
						</div>

					{:else}
						<div class="pane-scroll">
							<!-- You → them -->
							<div class="block">
								<div class="shared-head">
									<h3>You shared</h3>
									<button class="btn btn-ghost btn-xs" onclick={() => workspace.openOrFocus('contexts')}>＋ Share</button>
								</div>
								{#if sharedLoading}
									<div class="loading sm">Loading…</div>
								{:else if shared.spaces.length === 0 && shared.contexts.length === 0}
									<p class="shared-empty">You haven't shared anything with {displayName(selectedConnection)} yet. Grant a space (Spaces → a space → Members) or a mindscape facet (Sharing).</p>
								{:else}
									{#each shared.spaces as s (s.id)}
										<div class="shared-row"><span class="shared-label">{s.name} <span class="shared-role">· space · {s.role === 'contributor' ? 'can add' : 'can view'}</span></span><button class="link-revoke" onclick={() => revokeSpaceShare(s.id)}>Revoke</button></div>
									{/each}
									{#each shared.contexts as c (c.id)}
										<div class="shared-row"><span class="shared-label">{c.name} <span class="shared-role">· facet</span></span><button class="link-revoke" onclick={() => revokeContextGrant(c.id)}>Revoke</button></div>
									{/each}
								{/if}
							</div>

							<!-- Them → you -->
							<div class="block">
								<h3>Shared with you</h3>
								{#if sharedLoading}
									<div class="loading sm">Loading…</div>
								{:else if shared.inbound.length === 0}
									<p class="shared-empty">{displayName(selectedConnection)} hasn't shared anything with you yet. When they do, it'll appear here.</p>
								{:else}
									{#each shared.inbound as item (item.id)}
										<button class="shared-row inbound" onclick={() => openInboundShare(item)}>
											<span class="shared-label">{item.name || 'Shared ' + item.kind} <span class="shared-role">· {item.kind}{item.role ? ' · ' + (item.role === 'contributor' ? 'can add' : 'can view') : ''}</span></span>
											<span class="shared-open">Open ›</span>
										</button>
									{/each}
								{/if}
							</div>
						</div>
					{/if}
				{/if}
			</section>
		</div>
	{/if}

	<!-- Read-only viewer for an inbound share's contents (fetched from the peer) -->
	{#if viewing}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="share-modal-backdrop" onclick={closeShareViewer}>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="share-modal" onclick={(e) => e.stopPropagation()}>
				<header class="share-modal-head">
					<div>
						<span class="share-modal-title">{viewing.name || viewing.kind}</span>
						<span class="share-modal-sub">shared by {displayName(selectedConnection!)} · read-only</span>
					</div>
					<button class="icon-btn" aria-label="Close" onclick={closeShareViewer}>✕</button>
				</header>
				<div class="share-modal-body">
					{#if shareContentLoading}
						<div class="loading">Loading from {displayName(selectedConnection!)}'s instance…</div>
					{:else if shareContentError}
						<p class="share-empty">{shareContentError}</p>
					{:else if shareContent}
						{#if shareContent.kind === 'space'}
							{#if shareContent.knowledge?.length}
								<h4 class="share-h">Knowledge</h4>
								{#each shareContent.knowledge as k}<p class="share-knowledge">{k.content}</p>{/each}
							{/if}
							{#if shareContent.documents?.length}
								<h4 class="share-h">Documents</h4>
								{#each shareContent.documents as d}
									<div class="share-doc"><span class="share-doc-title">{d.title || d.path}</span>{#if d.summary}<span class="share-doc-sum">{d.summary}</span>{/if}</div>
								{/each}
							{/if}
							{#if !shareContent.knowledge?.length && !shareContent.documents?.length}<p class="share-empty">This space is empty.</p>{/if}
						{:else if shareContent.kind === 'context'}
							{#if shareContent.territories?.length}
								<h4 class="share-h">Territories</h4>
								{#each shareContent.territories as t}
									<div class="share-doc"><span class="share-doc-title">{t.name}</span>{#if t.essence}<span class="share-doc-sum">{t.essence}</span>{/if}</div>
								{/each}
							{:else}<p class="share-empty">Nothing shared in this facet.</p>{/if}
						{/if}
					{/if}
				</div>
			</div>
		</div>
	{/if}

	{#if error}<button type="button" class="toast error" onclick={() => (error = null)}>{error}</button>{/if}
	{#if success}<div class="toast success">{success}</div>{/if}
</div>

<style>
	.people { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
	.glass { background: var(--glass-card-bg); border: 1px solid var(--glass-border); border-radius: 16px; backdrop-filter: blur(14px) saturate(130%); -webkit-backdrop-filter: blur(14px) saturate(130%); }

	/* Avatars */
	.avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); }

	/* ── Empty / onboarding ── */
	.onboard { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }
	.onboard-card { max-width: 540px; padding: 2.25rem 2.25rem 1.75rem; text-align: center; }
	.orbit { width: 64px; height: 64px; margin: 0 auto 1.25rem; border-radius: 50%; border: 1px solid var(--glass-border); position: relative; background: radial-gradient(circle at 50% 50%, rgba(var(--color-accent-aurum-rgb),0.18), transparent 70%); }
	.orbit-dot { position: absolute; top: -3px; left: 50%; width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent-aurum); transform-origin: 50% 35px; animation: spin 6s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.onboard-card h2 { font-size: 1.4rem; font-weight: 400; color: var(--color-text-primary); margin-bottom: 0.6rem; }
	.lede { font-size: 0.9rem; line-height: 1.6; color: var(--color-text-secondary); margin-bottom: 1.5rem; }
	.big-composer { display: flex; gap: 0.5rem; }
	.big-composer input { flex: 1; padding: 0.7rem 0.9rem; font-family: var(--font-mono); font-size: 0.85rem; background: var(--glass-input-bg); border: 1px solid var(--glass-input-border); border-radius: 10px; color: var(--color-text-primary); outline: none; }
	.big-composer input:focus { border-color: var(--color-accent-aurum); }
	.hint { font-size: 0.74rem; color: var(--color-text-tertiary); margin-top: 0.9rem; }
	code { font-family: var(--font-mono); font-size: 0.92em; color: var(--color-text-primary); background: var(--glass-input-bg); padding: 1px 5px; border-radius: 4px; }

	/* ── Hub layout ── */
	.hub { flex: 1; display: grid; grid-template-columns: 320px 1fr; min-height: 0; }
	.sidebar { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--color-border); padding: 1rem 0.85rem; gap: 0.6rem; }
	.sb-top { display: flex; align-items: center; justify-content: space-between; }
	.sb-top h1 { font-size: 1.2rem; font-weight: 500; letter-spacing: -0.01em; color: var(--color-text-primary); }
	.inline-composer { display: flex; gap: 0.4rem; }
	.inline-composer input { flex: 1; min-width: 0; padding: 0.45rem 0.6rem; font-family: var(--font-mono); font-size: 0.78rem; background: var(--glass-input-bg); border: 1px solid var(--glass-input-border); border-radius: 8px; color: var(--color-text-primary); outline: none; }
	.inline-composer input:focus { border-color: var(--color-accent-aurum); }
	.search { padding: 0.5rem 0.7rem; font-size: 0.8rem; background: var(--glass-input-bg); border: 1px solid var(--glass-input-border); border-radius: 9px; color: var(--color-text-primary); outline: none; }
	.search:focus { border-color: var(--color-accent-aurum); }
	.sb-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.2rem; margin: 0 -0.2rem; padding: 0 0.2rem; }
	.sb-label { font-family: var(--font-mono); font-size: 0.6rem; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-text-tertiary); padding: 0.7rem 0.4rem 0.3rem; }

	/* People rows */
	.person { display: flex; align-items: center; gap: 0.7rem; padding: 0.55rem 0.6rem; border-radius: 11px; border: 1px solid transparent; background: none; width: 100%; text-align: left; cursor: pointer; transition: background 0.12s, border-color 0.12s; color: inherit; font-family: inherit; }
	.person:hover { background: var(--color-surface); }
	.person.selected { background: rgba(var(--color-accent-aurum-rgb), 0.08); border-color: rgba(var(--color-accent-aurum-rgb), 0.3); }
	.person-body { flex: 1; min-width: 0; }
	.person-line1 { display: flex; align-items: center; gap: 0.4rem; }
	.person-line2 { display: flex; align-items: center; gap: 0.3rem; margin-top: 0.05rem; }
	.name { font-weight: 600; font-size: 0.86rem; color: var(--color-text-emphasis); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.name.muted, .muted { color: var(--color-text-tertiary); }
	.handle { font-size: 0.72rem; color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.score { font-size: 0.72rem; color: var(--color-accent-aurum); white-space: nowrap; }
	.dot { color: var(--color-text-tertiary); font-size: 0.7rem; }
	.meta { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.unread { margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--color-accent-aurum); color: var(--color-bg); font-size: 0.68rem; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
	.invited { cursor: default; }
	.invited:hover { background: none; }
	.link-revoke { margin-left: auto; font-size: 0.68rem; color: var(--color-text-tertiary); background: none; border: none; cursor: pointer; flex-shrink: 0; }
	.link-revoke:hover { color: var(--color-accent-coral); }

	/* Request cards */
	.req-card { padding: 0.65rem 0.7rem; border-radius: 12px; border: 1px solid rgba(var(--color-accent-aurum-rgb), 0.32); background: rgba(var(--color-accent-aurum-rgb), 0.06); margin-bottom: 0.3rem; }
	.req-who { display: flex; align-items: center; gap: 0.6rem; }
	.who-text { display: flex; flex-direction: column; min-width: 0; }
	.req-sig { font-size: 0.74rem; color: var(--color-text-secondary); margin: 0.45rem 0 0; font-style: italic; }
	.req-actions { display: flex; gap: 0.4rem; margin-top: 0.55rem; }
	.req-actions .btn { flex: 1; }

	/* ── Main pane ── */
	.main { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
	.main-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.8rem; color: var(--color-text-tertiary); text-align: center; padding: 2rem; }
	.empty-glyph { font-size: 2rem; color: var(--color-text-tertiary); opacity: 0.4; }
	.main-empty p { font-size: 0.86rem; max-width: 320px; }

	.convo-head { display: flex; align-items: center; gap: 0.7rem; padding: 0.85rem 1.1rem; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
	.back { display: none; background: none; border: none; color: var(--color-text-secondary); font-size: 1.1rem; cursor: pointer; padding: 0 0.2rem; }
	.head-text { display: flex; flex-direction: column; min-width: 0; }
	.head-name { font-size: 0.95rem; font-weight: 600; color: var(--color-text-emphasis); }
	.head-sub { font-size: 0.72rem; color: var(--color-text-tertiary); }
	.instance { font-family: var(--font-mono); }
	.tabs { margin-left: auto; display: flex; gap: 0.15rem; background: var(--color-elevated); padding: 0.2rem; border-radius: 9px; }
	.tabs button { background: none; border: none; padding: 0.3rem 0.7rem; font-size: 0.76rem; border-radius: 7px; cursor: pointer; color: var(--color-text-tertiary); transition: all 0.12s; }
	.tabs button:hover { color: var(--color-text-secondary); }
	.tabs button.active { background: var(--color-surface); color: var(--color-text-primary); }
	.menu-wrap { position: relative; }
	.icon-btn { background: none; border: 1px solid var(--color-border); border-radius: 7px; color: var(--color-text-tertiary); cursor: pointer; padding: 0.25rem 0.5rem; line-height: 1; }
	.icon-btn:hover { color: var(--color-text-secondary); border-color: var(--color-text-tertiary); }
	.menu { position: absolute; right: 0; top: 115%; background: var(--color-elevated); border: 1px solid var(--glass-border); border-radius: 9px; padding: 0.25rem; z-index: 30; min-width: 130px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
	.menu-item { display: block; width: 100%; text-align: left; background: none; border: none; padding: 0.45rem 0.6rem; font-size: 0.78rem; border-radius: 6px; cursor: pointer; color: var(--color-text-secondary); }
	.menu-item.danger { color: var(--color-accent-coral); }
	.menu-item:hover { background: var(--color-surface); }

	/* Thread */
	.thread { flex: 1; overflow-y: auto; padding: 1.1rem 1.1rem 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
	.thread-empty { margin: auto; text-align: center; max-width: 340px; color: var(--color-text-secondary); font-size: 0.85rem; line-height: 1.6; }
	.thread-empty .muted { font-size: 0.78rem; margin-top: 0.4rem; }
	.bubble-row { display: flex; }
	.bubble-row.out { justify-content: flex-end; }
	.bubble-row.in { justify-content: flex-start; }
	.bubble { max-width: 72%; padding: 0.5rem 0.75rem; border-radius: 15px; font-size: 0.86rem; line-height: 1.45; position: relative; }
	.bubble.in { background: var(--color-surface); border: 1px solid var(--color-border); border-bottom-left-radius: 5px; color: var(--color-text-primary); }
	.bubble.out { background: var(--color-accent-aurum); color: var(--color-bg); border-bottom-right-radius: 5px; }
	.bubble.out.failed { background: rgba(var(--color-accent-coral-rgb), 0.9); }
	.bubble-text { white-space: pre-wrap; word-break: break-word; }
	.bubble-meta { display: block; font-size: 0.62rem; opacity: 0.7; margin-top: 0.25rem; text-align: right; }
	.bubble.in .bubble-meta { text-align: left; color: var(--color-text-tertiary); opacity: 1; }

	/* Composer */
	.compose { display: flex; align-items: flex-end; gap: 0.5rem; padding: 0.7rem 1.1rem 1rem; border-top: 1px solid var(--color-border); flex-shrink: 0; }
	.compose textarea { flex: 1; resize: none; max-height: 120px; padding: 0.6rem 0.8rem; font-family: var(--font-sans); font-size: 0.86rem; line-height: 1.4; background: var(--glass-input-bg); border: 1px solid var(--glass-input-border); border-radius: 12px; color: var(--color-text-primary); outline: none; }
	.compose textarea:focus { border-color: var(--color-accent-aurum); }
	.send { width: 36px; height: 36px; flex-shrink: 0; border-radius: 50%; border: none; background: var(--color-accent-aurum); color: var(--color-bg); font-size: 1rem; cursor: pointer; transition: opacity 0.12s; }
	.send:disabled { opacity: 0.4; cursor: not-allowed; }

	/* Overlap + shared panes */
	.pane-scroll { flex: 1; overflow-y: auto; padding: 1.25rem; max-width: 720px; }
	.summary-row { display: flex; align-items: center; gap: 0.7rem; padding-bottom: 1rem; border-bottom: 1px solid var(--color-border); margin-bottom: 1.25rem; }
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
	.shared-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.7rem; }
	.shared-head h3 { margin-bottom: 0; }
	.shared-empty { font-size: 0.8rem; color: var(--color-text-tertiary); line-height: 1.5; }
	.shared-row { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.4rem 0; }
	.shared-row.inbound { width: 100%; text-align: left; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 9px; padding: 0.55rem 0.7rem; margin-bottom: 0.3rem; cursor: pointer; transition: border-color 0.12s; }
	.shared-row.inbound:hover { border-color: var(--color-accent-aurum); }
	.shared-open { font-size: 0.74rem; color: var(--color-accent-aurum); white-space: nowrap; }
	.shared-label { font-size: 0.82rem; color: var(--color-text-primary); }

	/* Inbound-share content viewer */
	.share-modal-backdrop { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
	.share-modal { width: 100%; max-width: 560px; max-height: 80vh; display: flex; flex-direction: column; background: var(--color-surface); border: 1px solid var(--glass-border); border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.4); overflow: hidden; }
	.share-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 1rem 1.2rem; border-bottom: 1px solid var(--color-border); }
	.share-modal-title { display: block; font-size: 1rem; font-weight: 600; color: var(--color-text-emphasis); }
	.share-modal-sub { font-size: 0.74rem; color: var(--color-text-tertiary); }
	.share-modal-body { overflow-y: auto; padding: 1.1rem 1.2rem; }
	.share-h { font-family: var(--font-mono); font-size: 0.6rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text-tertiary); margin: 0.5rem 0 0.6rem; }
	.share-knowledge { font-size: 0.84rem; line-height: 1.55; color: var(--color-text-primary); background: var(--color-elevated); padding: 0.6rem 0.75rem; border-radius: 9px; margin-bottom: 0.5rem; white-space: pre-wrap; }
	.share-doc { display: flex; flex-direction: column; gap: 0.1rem; padding: 0.5rem 0; border-bottom: 1px solid var(--color-border); }
	.share-doc-title { font-size: 0.84rem; color: var(--color-text-primary); }
	.share-doc-sum { font-size: 0.76rem; color: var(--color-text-tertiary); }
	.share-empty { font-size: 0.82rem; color: var(--color-text-tertiary); }
	.shared-role { color: var(--color-text-tertiary); font-size: 0.74rem; }

	/* Buttons */
	.btn { padding: 0.4rem 0.8rem; font-size: 0.78rem; font-family: var(--font-sans); border-radius: 8px; cursor: pointer; border: none; transition: all 0.15s; white-space: nowrap; }
	.btn-sm { padding: 0.35rem 0.7rem; font-size: 0.76rem; }
	.btn-xs { padding: 0.3rem 0.6rem; font-size: 0.72rem; }
	.btn-primary { background: var(--color-accent-aurum); color: var(--color-bg); font-weight: 500; }
	.btn-primary:hover { opacity: 0.9; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { background: transparent; color: var(--color-text-secondary); border: 1px solid var(--color-border); }
	.btn-ghost:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }

	.loading { text-align: center; padding: 2rem; color: var(--color-text-tertiary); font-size: 0.82rem; }
	.loading.sm { padding: 0.75rem; }
	.toast { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); padding: 0.5rem 1.25rem; border-radius: 8px; font-size: 0.78rem; z-index: 100; border: none; }
	.toast.error { background: rgba(var(--color-accent-coral-rgb), 0.15); border: 1px solid rgba(var(--color-accent-coral-rgb), 0.3); color: var(--color-accent-coral); cursor: pointer; }
	.toast.success { background: rgba(var(--color-accent-jade-rgb), 0.15); border: 1px solid rgba(var(--color-accent-jade-rgb), 0.3); color: var(--color-accent-jade); }

	/* Narrow */
	@media (max-width: 760px) {
		.hub { grid-template-columns: 1fr; }
		.sidebar { border-right: none; }
		.main { position: absolute; inset: 0; background: var(--color-bg); z-index: 5; }
		.main:not(:has(.main-empty)) { display: flex; }
		.back { display: block; }
		.tabs { margin-left: 0; }
	}
</style>
