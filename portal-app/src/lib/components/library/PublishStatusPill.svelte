<script lang="ts">
	/**
	 * PublishStatusPill — visibility surface for a library doc.
	 *
	 * Three states reflect the doc's current public reach:
	 *   private   (gray dot)   — no one but the operator can read
	 *   shared    (azure dot)  — at least one active share-link
	 *   published (aurum dot)  — anyone on the web at <handle>.mycelium.id/p/<slug>
	 *
	 * The pill is the click target. The popover beneath houses two
	 * sections: "Publish to web" and "Share with people". A doc can
	 * be in BOTH states simultaneously (published AND share-linked);
	 * we display the more-public state on the pill but show both
	 * affordances in the popover.
	 *
	 * Live counts (visit count + reading-now) refresh every 5s while
	 * the popover is open, then stop. Closed popover = no polling.
	 *
	 * Replaces the old "live" badge that pulsed when an agent edited
	 * the doc; live-watch is now an implicit guarantee of the
	 * publishing pipeline (auto-republish on edit).
	 */
	import { api, apiPost, apiDelete } from '$lib/api';
	import { onDestroy } from 'svelte';

	type ShareLink = {
		token: string;
		url: string;
		invitedEmail: string | null;
		expiresAt: string;
		maxViews: number | null;
		viewCount: number;
		createdAt: string;
	};
	type ShareStatus = {
		path: string;
		published: boolean;
		slug: string | null;
		publicUrl: string | null;
		visitCount: number;
		readingNow: number;
		shareLinks: ShareLink[];
	};

	let { docPath, classes = '' }: { docPath: string; classes?: string } = $props();

	let open = $state(false);
	let loading = $state(false);
	let status = $state<ShareStatus | null>(null);
	let error = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let pillButton = $state<HTMLButtonElement | null>(null);
	let popoverEl = $state<HTMLDivElement | null>(null);

	// Form state — kept in sync with the popover's two action sections.
	let publishSlugInput = $state('');
	let publishBusy = $state(false);
	let unpublishBusy = $state(false);
	let copiedPublic = $state(false);

	let inviteEmail = $state('');
	let inviteExpiresDays = $state(30);
	let inviteMaxViews = $state<number | null>(null);
	let inviteBusy = $state(false);
	let lastCreatedToken = $state<string | null>(null);
	let copiedToken = $state<string | null>(null);

	// Derive pill state for chrome.
	const visState = $derived.by<'private' | 'shared' | 'published'>(() => {
		if (!status) return 'private';
		if (status.published) return 'published';
		if (status.shareLinks.some(isActiveLink)) return 'shared';
		return 'private';
	});

	function isActiveLink(l: ShareLink): boolean {
		const notExpired = Date.parse(l.expiresAt) > Date.now();
		const notMaxedOut = l.maxViews === null || l.viewCount < l.maxViews;
		return notExpired && notMaxedOut;
	}

	async function load() {
		if (!docPath) return;
		loading = true;
		error = null;
		try {
			const res = await api(`/portal/documents/${docPath}/share-status`);
			if (!res.ok) throw new Error(`load failed (${res.status})`);
			const data = await res.json();
			status = data;
			if (!publishSlugInput && status?.slug) publishSlugInput = status.slug;
		} catch (e: any) {
			error = e?.message || 'load failed';
		} finally {
			loading = false;
		}
	}

	function startPolling() {
		stopPolling();
		// 5s cadence — the public route updates visit count fire-and-forget,
		// and presence rows beat every 10s, so 5s on the polling side is the
		// cheapest cadence that still feels live.
		pollTimer = setInterval(load, 5000);
	}
	function stopPolling() {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	}

	async function togglePopover() {
		open = !open;
		if (open) {
			await load();
			startPolling();
		} else {
			stopPolling();
		}
	}

	function close() {
		open = false;
		stopPolling();
	}

	// Close on outside click / Esc.
	function onWindowClick(e: MouseEvent) {
		if (!open) return;
		const target = e.target as Node;
		if (popoverEl?.contains(target) || pillButton?.contains(target)) return;
		close();
	}
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) close();
	}

	$effect(() => {
		if (typeof window === 'undefined') return;
		window.addEventListener('mousedown', onWindowClick);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('mousedown', onWindowClick);
			window.removeEventListener('keydown', onKey);
		};
	});

	// Load share-status as soon as the pill knows which doc to display.
	// Without this the pill shows "Private" until the user clicks it,
	// even when an active share-link exists. We re-run on docPath change
	// so navigating between docs in-place picks up the new state.
	$effect(() => {
		if (docPath) load();
	});

	// Sum of views across active share-links — surfaced on the pill
	// next to the "shared" label. View counts on individual links are
	// still shown in the popover.
	const sharedViews = $derived.by(() => {
		if (!status) return 0;
		return status.shareLinks
			.filter(isActiveLink)
			.reduce((n, l) => n + (l.viewCount || 0), 0);
	});

	onDestroy(stopPolling);

	// ─── Actions ────────────────────────────────────────────────────────

	async function publish() {
		publishBusy = true;
		try {
			const slug = publishSlugInput.trim() || undefined;
			const res = await apiPost<ShareStatus>(`/portal/documents/${docPath}/publish`, slug ? { slug } : {});
			// publish returns { published, slug, publicUrl } — re-fetch full status.
			await load();
		} catch (e: any) {
			error = e?.message || 'publish failed';
		} finally {
			publishBusy = false;
		}
	}

	async function unpublish() {
		unpublishBusy = true;
		try {
			await apiPost(`/portal/documents/${docPath}/unpublish`, {});
			await load();
		} catch (e: any) {
			error = e?.message || 'unpublish failed';
		} finally {
			unpublishBusy = false;
		}
	}

	async function createShareLink() {
		inviteBusy = true;
		lastCreatedToken = null;
		try {
			const body: Record<string, unknown> = { expiresInDays: inviteExpiresDays };
			if (inviteEmail.trim()) body.invitedEmail = inviteEmail.trim();
			if (typeof inviteMaxViews === 'number' && inviteMaxViews > 0) body.maxViews = inviteMaxViews;
			const res = await apiPost<{ token: string; url: string; expiresAt: string }>(
				`/portal/documents/${docPath}/share`,
				body,
			);
			lastCreatedToken = res.token;
			inviteEmail = '';
			inviteMaxViews = null;
			await load();
		} catch (e: any) {
			error = e?.message || 'share failed';
		} finally {
			inviteBusy = false;
		}
	}

	async function revokeShareLink(token: string) {
		try {
			await apiDelete(`/portal/share-links/${token}`);
			await load();
		} catch (e: any) {
			error = e?.message || 'revoke failed';
		}
	}

	async function copyToClipboard(text: string, kind: 'public' | string) {
		try {
			await navigator.clipboard.writeText(text);
			if (kind === 'public') {
				copiedPublic = true;
				setTimeout(() => { copiedPublic = false; }, 1500);
			} else {
				copiedToken = kind;
				setTimeout(() => { copiedToken = null; }, 1500);
			}
		} catch {
			/* fallback omitted; modern browsers always have clipboard API */
		}
	}

	function shortDate(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	// Slug regex matches the server-side validator. Held in a variable
	// because Svelte 5 interprets `{0,62}` in a literal attribute as a
	// comma-expression rune, mangling the regex.
	//
	// HTML <input pattern> is parsed under the /v flag in modern browsers
	// (Chromium 121+), where a bare `-` between literal characters in a
	// character class is rejected as "Invalid character class". Escape
	// the hyphen to keep the pattern valid under both /u and /v.
	const SLUG_PATTERN = '^[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?$';

	function shortHandleFromUrl(url: string | null): string {
		if (!url) return '';
		try {
			const u = new URL(url);
			return u.hostname + u.pathname;
		} catch {
			return url;
		}
	}
</script>

<div class="relative {classes}">
	<!-- Pill -->
	<button
		bind:this={pillButton}
		type="button"
		onclick={togglePopover}
		class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-sm transition-colors text-[10px] font-mono text-white/90"
		aria-haspopup="dialog"
		aria-expanded={open}
		title={visState === 'private' ? 'Private' : visState === 'shared' ? 'Shared' : 'Published'}
	>
		<span
			class="w-1.5 h-1.5 rounded-full {
				visState === 'published' ? 'bg-aurum' :
				visState === 'shared' ? 'bg-azure' :
				'bg-white/40'
			}"
			aria-hidden="true"
		></span>
		<span class="uppercase tracking-wider">{visState}</span>
		{#if status?.published}
			<span class="text-white/60">·</span>
			<svg class="w-3 h-3 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" />
				<circle cx="12" cy="12" r="3" />
			</svg>
			<span class="tabular-nums">{status.visitCount}</span>
			{#if status.readingNow > 0}
				<span class="text-white/60">·</span>
				<span class="tabular-nums text-aurum">{status.readingNow} reading</span>
			{/if}
		{:else if visState === 'shared'}
			<span class="text-white/60">·</span>
			<svg class="w-3 h-3 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z" />
				<circle cx="12" cy="12" r="3" />
			</svg>
			<span class="tabular-nums">{sharedViews}</span>
		{/if}
	</button>

	<!-- Popover -->
	{#if open}
		<div
			bind:this={popoverEl}
			class="absolute right-0 top-9 z-50 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl text-[var(--color-text-primary)]"
			role="dialog"
			aria-label="Publishing options"
		>
			<div class="px-4 pt-4 pb-2 flex items-start justify-between gap-3 border-b border-[var(--color-border)]">
				<div>
					<h3 class="text-sm font-medium">Sharing &amp; publishing</h3>
					<p class="text-[11px] text-[var(--color-text-tertiary)] mt-0.5">
						{visState === 'private' ? 'Only you can read this doc.'
							: visState === 'shared' ? 'Reachable via tokenised links you create.'
							: 'Anyone on the web can read it.'}
					</p>
				</div>
				<button
					type="button"
					onclick={close}
					class="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
					aria-label="Close"
				>
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			{#if error}
				<div class="mx-4 mt-3 px-3 py-2 rounded-md bg-coral/10 text-coral text-xs">{error}</div>
			{/if}

			<!-- ── Publish to web ── -->
			<section class="px-4 pt-3 pb-4 space-y-2">
				<div class="flex items-center gap-2">
					<span class="w-1.5 h-1.5 rounded-full {status?.published ? 'bg-aurum' : 'bg-white/30'}"></span>
					<h4 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">Publish to the web</h4>
				</div>
				<p class="text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">
					Anyone on the open internet can read the page at
					<code class="text-[10px]">your-handle.mycelium.id/p/&lt;slug&gt;</code>.
					Edits to this doc reflect within ~5s.
				</p>

				<div class="flex items-center gap-2">
					<span class="text-[11px] text-[var(--color-text-tertiary)]">Slug:</span>
					<input
						type="text"
						bind:value={publishSlugInput}
						placeholder="auto from filename"
						pattern={SLUG_PATTERN}
						class="flex-1 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs font-mono text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
				</div>

				{#if status?.published}
					<div class="flex items-center gap-2 text-[11px]">
						<a
							href={status.publicUrl || '#'}
							target="_blank"
							rel="noreferrer noopener"
							class="flex-1 truncate text-aurum hover:underline font-mono"
						>{shortHandleFromUrl(status.publicUrl)}</a>
						<button
							type="button"
							onclick={() => status?.publicUrl && copyToClipboard(status.publicUrl, 'public')}
							class="px-2 py-0.5 rounded bg-[var(--color-elevated)] hover:bg-[var(--color-border)] transition-colors text-[10px]"
							title="Copy URL"
						>
							{copiedPublic ? '✓ copied' : 'copy'}
						</button>
					</div>
					<div class="text-[11px] text-[var(--color-text-tertiary)] tabular-nums">
						<span>{status.visitCount} {status.visitCount === 1 ? 'visit' : 'visits'}</span>
						<span class="mx-1.5">·</span>
						<span class="text-aurum">{status.readingNow} reading now</span>
					</div>
					<button
						type="button"
						onclick={unpublish}
						disabled={unpublishBusy}
						class="w-full px-3 py-1.5 rounded-md text-xs font-medium bg-coral/10 text-coral hover:bg-coral/20 transition-colors disabled:opacity-50"
					>
						{unpublishBusy ? 'Unpublishing…' : 'Unpublish'}
					</button>
				{:else}
					<button
						type="button"
						onclick={publish}
						disabled={publishBusy}
						class="w-full px-3 py-1.5 rounded-md text-xs font-medium bg-aurum text-[var(--color-bg)] hover:opacity-90 transition-opacity disabled:opacity-50"
					>
						{publishBusy ? 'Publishing…' : 'Publish to the web'}
					</button>
					<p class="text-[10px] text-[var(--color-text-tertiary)] italic">
						Heads up: the entire HTML body becomes public — review it for secrets first.
					</p>
				{/if}
			</section>

			<div class="border-t border-[var(--color-border)]"></div>

			<!-- ── Share with people ── -->
			<section class="px-4 pt-3 pb-4 space-y-2">
				<div class="flex items-center gap-2">
					<span class="w-1.5 h-1.5 rounded-full {visState === 'shared' ? 'bg-azure' : 'bg-white/30'}"></span>
					<h4 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">Share with specific people</h4>
				</div>
				<p class="text-[11px] text-[var(--color-text-tertiary)] leading-relaxed">
					Generate a tokenised URL anyone can open without an account.
					The link itself is the auth — keep it private.
				</p>

				<div class="space-y-1.5">
					<input
						type="email"
						bind:value={inviteEmail}
						placeholder="Recipient email (optional, for your records)"
						class="w-full px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
					/>
					<div class="flex items-center gap-2">
						<select
							bind:value={inviteExpiresDays}
							class="flex-1 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs text-[var(--color-text-primary)]"
						>
							<option value={1}>Expires in 1 day</option>
							<option value={7}>Expires in 7 days</option>
							<option value={30}>Expires in 30 days</option>
							<option value={365}>Expires in 1 year</option>
						</select>
						<input
							type="number"
							min="1"
							bind:value={inviteMaxViews}
							placeholder="Max views"
							class="w-24 px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
						/>
					</div>
				</div>

				<button
					type="button"
					onclick={createShareLink}
					disabled={inviteBusy}
					class="w-full px-3 py-1.5 rounded-md text-xs font-medium bg-azure text-white hover:opacity-90 transition-opacity disabled:opacity-50"
				>
					{inviteBusy ? 'Creating…' : 'Create share link'}
				</button>

				{#if status?.shareLinks?.length}
					<ul class="mt-2 space-y-1.5">
						{#each status.shareLinks as link (link.token)}
							{@const active = isActiveLink(link)}
							<li class="rounded-md border border-[var(--color-border)] px-2 py-1.5 bg-[var(--color-bg)] {active ? '' : 'opacity-60'}">
								<div class="flex items-center gap-1.5 text-[11px]">
									<a
										href={link.url}
										target="_blank"
										rel="noreferrer noopener"
										class="flex-1 truncate font-mono {active ? 'text-azure hover:underline' : 'text-[var(--color-text-tertiary)] line-through'}"
										title={link.url}
									>
										{link.url.replace(/^https?:\/\//, '')}
									</a>
									<button
										type="button"
										onclick={() => copyToClipboard(link.url, link.token)}
										class="px-1.5 py-0.5 rounded bg-[var(--color-elevated)] hover:bg-[var(--color-border)] text-[10px]"
										title="Copy URL"
									>
										{copiedToken === link.token ? '✓' : '📋'}
									</button>
									<button
										type="button"
										onclick={() => revokeShareLink(link.token)}
										class="px-1.5 py-0.5 rounded bg-coral/10 text-coral hover:bg-coral/20 text-[10px]"
										title="Revoke link"
										aria-label="Revoke link"
									>
										✕
									</button>
								</div>
								<div class="text-[10px] text-[var(--color-text-tertiary)] mt-0.5 flex flex-wrap items-center gap-x-2">
									{#if link.invitedEmail}
										<span>{link.invitedEmail}</span>
										<span>·</span>
									{/if}
									<span class="tabular-nums">{link.viewCount}{link.maxViews ? `/${link.maxViews}` : ''} views</span>
									<span>·</span>
									<span>expires {shortDate(link.expiresAt)}</span>
									{#if !active}
										<span class="text-coral">(inactive)</span>
									{/if}
								</div>
								{#if lastCreatedToken === link.token}
									<div class="mt-1 text-[10px] text-aurum">↑ just created — copy now</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</div>
