<script lang="ts">
	import { onMount } from 'svelte';
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { api } from '$lib/api';
	import {
		parseSource, getSourceStyle, classifySpeaker,
		extractReplyContext, stripAttachmentPlaceholder,
		formatDateHeader, formatTime, formatFileSize, formatChannelLabel,
		type TimelineMessage, type AgentInfo, type OwnerIdentity,
	} from '$lib/timeline/utils';
	import { canonicalClientSource } from '$lib/streams/sources';

	marked.use({ breaks: true, gfm: true });

	// When embedded under the source spectrum, the spectrum drives the filter
	// (externalSource = a canonical source key) and the in-feed source buttons are
	// hidden (showSourceFilter=false) so there's one filter, not two.
	let { externalSource = null, showSourceFilter = true }:
		{ externalSource?: string | null; showSourceFilter?: boolean } = $props();

	let messages = $state<TimelineMessage[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let sourceFilter = $state<string | null>(null);
	let channelFilter = $state<string | null>(null);
	let expandedImage = $state<string | null>(null);
	let expandedIds = $state<Set<string>>(new Set());

	// Hydrated on mount, used by classifySpeaker.
	let agentMap = $state<Map<string, AgentInfo>>(new Map());
	let owner = $state<OwnerIdentity>({
		ownerName: null, ownerTelegramId: null, ownerDiscordId: null,
	});

	// Memoised markdown — re-rendered only when content changes.
	const renderedHtml = new Map<string, string>();
	function renderMarkdown(id: string, content: string): string {
		const cached = renderedHtml.get(id);
		if (cached !== undefined) return cached;
		const raw = marked.parse(content, { async: false }) as string;
		const safe = DOMPurify.sanitize(raw);
		// Cap cache to avoid unbounded growth on long timelines.
		if (renderedHtml.size > 500) {
			const oldest = renderedHtml.keys().next().value;
			if (oldest) renderedHtml.delete(oldest);
		}
		renderedHtml.set(id, safe);
		return safe;
	}

	const sources = ['telegram', 'discord', 'whatsapp', 'portal'];

	onMount(async () => {
		// Three parallel fetches: messages, agent registry, owner identity.
		// Failure on either side panel is non-fatal — the timeline still
		// renders, just with degraded labels.
		await Promise.all([
			loadMessages(),
			loadAgents(),
			loadIdentity(),
		]);
		loading = false;
	});

	async function loadAgents() {
		try {
			const res = await api('/portal/agents');
			if (!res.ok) return;
			const data = await res.json();
			const next = new Map<string, AgentInfo>();
			for (const a of (data.agents || [])) {
				next.set(a.id, {
					id: a.id,
					name: a.name || a.defaultName || a.id,
					color: a.color || null,
					avatarEmoji: a.avatarEmoji || null,
				});
			}
			agentMap = next;
		} catch { /* non-fatal */ }
	}

	async function loadIdentity() {
		try {
			const res = await api('/portal/identity');
			if (!res.ok) return;
			const data = await res.json();
			owner = {
				ownerName:       data.ownerName       ?? null,
				ownerTelegramId: data.ownerTelegramId ?? null,
				ownerDiscordId:  data.ownerDiscordId  ?? null,
			};
		} catch { /* non-fatal */ }
	}

	async function loadMessages(before?: string) {
		const params = new URLSearchParams({ limit: '50' });
		if (before) params.set('before', before);
		try {
			const res = await api(`/portal/messages?${params}`);
			if (!res.ok) return;
			const data = await res.json();
			const newMessages: TimelineMessage[] = data.messages || [];
			messages = before ? [...messages, ...newMessages] : newMessages;
		} catch { /* non-fatal */ }
	}

	async function loadMore() {
		if (loadingMore || messages.length === 0) return;
		loadingMore = true;
		const lastMsg = messages[messages.length - 1];
		await loadMessages(lastMsg.created_at);
		loadingMore = false;
	}

	function toggleExpand(id: string) {
		const next = new Set(expandedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedIds = next;
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape' && expandedIds.size > 0) {
			expandedIds = new Set();
		}
	}

	// Source filter narrows by platform; channel filter narrows further to a
	// single chat/channel within that source. The channel filter only takes
	// effect when a source is selected (otherwise it'd be stale across
	// re-filters).
	// externalSource (spectrum-driven) takes precedence and matches ANY source by
	// its canonical key — so gmail/obsidian/agent rows filter too, not just the
	// four platforms the in-feed buttons knew. Falls back to the legacy in-feed
	// sourceFilter when the spectrum isn't driving.
	const sourceFilteredMessages = $derived(
		externalSource
			? messages.filter(m => canonicalClientSource(m.source) === externalSource)
			: sourceFilter
				? messages.filter(m => parseSource(m.source).platform === sourceFilter
					|| parseSource(m.source).platform === `${sourceFilter}-group`)
				: messages,
	);

	const filteredMessages = $derived(
		sourceFilter && channelFilter
			? sourceFilteredMessages.filter(m =>
				m.channelId === channelFilter || m.channel === channelFilter)
			: sourceFilteredMessages,
	);

	// Distinct channels currently visible in the source filter, ordered by
	// most-recent activity. Capped at 8 so a busy account doesn't spawn a
	// rambling pill row. Each entry: { key, label, count }.
	//   key   — what we filter on (channelId preferred, falls back to channel name)
	//   label — what we render (channel name preferred, falls back to id)
	const channelPills = $derived.by(() => {
		if (!sourceFilter) return [];
		const seen = new Map<string, { key: string; label: string; count: number; latest: number }>();
		for (const m of sourceFilteredMessages) {
			const key = m.channelId || m.channel || null;
			if (!key) continue;
			const label = m.channel || m.channelId || key;
			const ts = new Date(m.created_at).getTime();
			const prev = seen.get(key);
			if (prev) {
				prev.count++;
				if (ts > prev.latest) prev.latest = ts;
			} else {
				seen.set(key, { key, label, count: 1, latest: ts });
			}
		}
		return Array.from(seen.values())
			.sort((a, b) => b.latest - a.latest)
			.slice(0, 8);
	});

	// Reset channelFilter whenever the source filter changes — otherwise a
	// stale channel id from a different source silently empties the view.
	$effect(() => {
		// Touch sourceFilter so the effect re-runs on its change.
		void sourceFilter;
		channelFilter = null;
	});

	// Group messages by date for "Today / Yesterday / Monday, April 27".
	const groupedMessages = $derived.by(() => {
		const groups: Array<{ date: string; label: string; messages: TimelineMessage[] }> = [];
		let currentDate = '';
		for (const msg of filteredMessages) {
			const d = new Date(msg.created_at);
			const dateStr = d.toDateString();
			if (dateStr !== currentDate) {
				currentDate = dateStr;
				groups.push({ date: dateStr, label: formatDateHeader(d), messages: [] });
			}
			groups[groups.length - 1].messages.push(msg);
		}
		return groups;
	});

	// "show more" gate — applied to the rendered markdown via CSS clamp.
	function isLong(content: string): boolean {
		if (!content) return false;
		// ~6 lines @ ~80 chars or 500+ chars total.
		return content.length > 500 || content.split('\n').length > 6;
	}
</script>

<svelte:head>
	<title>Timeline - Mycelium</title>
</svelte:head>

<svelte:window on:keydown={handleKeyDown} />

<!-- Image lightbox -->
{#if expandedImage}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
		onclick={() => expandedImage = null}
		onkeydown={(e) => { if (e.key === 'Escape') expandedImage = null; }}
		role="dialog"
		tabindex="-1"
	>
		<img src={expandedImage} alt="" class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
	</div>
{/if}

<div class="flex flex-col h-full">
	<!-- Filters: source row + (when a source is selected) channel sub-row.
	     When embedded under the spectrum (showSourceFilter=false) the source row is
	     replaced by a slim count bar — the spectrum chips ARE the source filter. -->
	<div class="border-b border-[var(--color-border)]">
		{#if showSourceFilter}
		<div class="flex items-center gap-2 px-4 sm:px-6 py-3 flex-wrap">
			<button
				onclick={() => sourceFilter = null}
				class="tag text-xs transition-colors"
				class:tag-azure={!sourceFilter}
				aria-pressed={!sourceFilter}
			>
				All
			</button>
			{#each sources as s}
				<button
					onclick={() => sourceFilter = sourceFilter === s ? null : s}
					class="tag text-xs transition-colors"
					class:tag-azure={sourceFilter === s}
					aria-pressed={sourceFilter === s}
				>
					{s}
				</button>
			{/each}
			{#if messages.length > 0}
				<span class="ml-auto text-xs text-[var(--color-text-tertiary)]">
					{filteredMessages.length} {filteredMessages.length === 1 ? 'message' : 'messages'}
				</span>
			{/if}
		</div>
		{:else if messages.length > 0}
		<div class="flex items-center gap-2 px-4 sm:px-6 py-2.5">
			<span class="text-xs text-[var(--color-text-tertiary)]">
				{filteredMessages.length} {filteredMessages.length === 1 ? 'message' : 'messages'}{#if externalSource}{' '}in {externalSource}{/if}
			</span>
		</div>
		{/if}
		{#if showSourceFilter && sourceFilter && channelPills.length > 0}
			<div class="flex items-center gap-2 px-4 sm:px-6 pb-3 flex-wrap">
				<span class="text-[0.65rem] uppercase tracking-wider text-[var(--color-text-tertiary)] mr-1">
					Channels
				</span>
				<button
					onclick={() => channelFilter = null}
					class="tag text-xs transition-colors"
					class:tag-azure={!channelFilter}
					aria-pressed={!channelFilter}
				>
					All
				</button>
				{#each channelPills as p (p.key)}
					<button
						onclick={() => channelFilter = channelFilter === p.key ? null : p.key}
						class="tag text-xs transition-colors max-w-[16rem] truncate"
						class:tag-azure={channelFilter === p.key}
						aria-pressed={channelFilter === p.key}
						title={`${p.label} · ${p.count} ${p.count === 1 ? 'message' : 'messages'}`}
					>
						{p.label}
						<span class="text-[var(--color-text-tertiary)] ml-1">{p.count}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Messages -->
	<div class="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
		{#if loading}
			<div class="flex items-center justify-center min-h-[200px]" role="status" aria-live="polite">
				<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading timeline...</div>
			</div>
		{:else if filteredMessages.length === 0}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-center">
					{#if !sourceFilter}
						<p class="text-[var(--color-text-tertiary)] text-sm">No messages yet</p>
						<p class="text-[var(--color-text-tertiary)] text-xs mt-1">Messages from all your channels will appear here</p>
					{:else if !channelFilter}
						<p class="text-[var(--color-text-tertiary)] text-sm">No {sourceFilter} messages in view</p>
						<button
							class="text-[var(--color-text-tertiary)] text-xs mt-1 underline hover:text-[var(--color-text-secondary)]"
							onclick={() => sourceFilter = null}
						>
							Clear filter
						</button>
					{:else}
						<p class="text-[var(--color-text-tertiary)] text-sm">No messages in this channel</p>
						<button
							class="text-[var(--color-text-tertiary)] text-xs mt-1 underline hover:text-[var(--color-text-secondary)]"
							onclick={() => channelFilter = null}
						>
							Show all {sourceFilter} channels
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="max-w-3xl mx-auto">
				{#each groupedMessages as group (group.date)}
					<div class="section-marker text-xs my-4">
						<span>{group.label}</span>
					</div>

					<div class="space-y-1">
						{#each group.messages as msg (msg.id)}
							{@const parsed = parseSource(msg.source)}
							{@const sc = getSourceStyle(parsed.platform)}
							{@const speaker = classifySpeaker(msg, owner, agentMap)}
							{@const reply = extractReplyContext(msg.content)}
							{@const channelLabel = formatChannelLabel(msg.source, msg.channel || reply.groupTitle)}
							{@const bodyText = stripAttachmentPlaceholder(reply.body, msg.attachment)}
							{@const expanded = expandedIds.has(msg.id)}
							{@const longContent = isLong(bodyText)}
							<article
								class="flex gap-2 sm:gap-3 items-start rounded-lg px-2 sm:px-3 py-2.5 -mx-2 sm:-mx-3 hover:bg-[var(--color-hover)] transition-colors"
								aria-label={`${speaker.label} via ${sc.title}${channelLabel ? ` in ${channelLabel}` : ''} at ${formatTime(msg.created_at)}`}
							>
								<!-- Source badge — brand glyph (CC0 from simple-icons) -->
								<div
									class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
									style="background: {sc.bg}; color: {sc.text};"
									title={sc.title}
								>
									<svg viewBox="0 0 24 24" class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="currentColor" aria-hidden="true">
										<path d={sc.iconPath} />
									</svg>
								</div>

								<!-- Content -->
								<div class="flex-1 min-w-0">
									<!-- Header: speaker + channel + time + attachment-type chip -->
									<header class="flex items-baseline gap-2 mb-0.5 flex-wrap">
										<span class="text-xs font-medium" style="color: {speaker.color};">
											{#if speaker.emoji}<span class="mr-0.5" aria-hidden="true">{speaker.emoji}</span>{/if}{speaker.label}
										</span>
										{#if channelLabel}
											<span class="text-[0.65rem] text-[var(--color-text-tertiary)]">·&nbsp;{channelLabel}</span>
										{/if}
										<time class="text-[0.65rem] text-[var(--color-text-tertiary)]" datetime={msg.created_at}>
											{formatTime(msg.created_at)}
										</time>
										{#if msg.attachment}
											<span class="text-[0.6rem] text-[var(--color-text-tertiary)] uppercase tracking-wider">{msg.attachment.type}</span>
										{/if}
									</header>

									<!-- Reply context pill -->
									{#if reply.replyToName || reply.quote}
										<div class="mb-1 px-2 py-1 rounded-md border-l-2 border-[var(--color-border)] bg-[var(--color-elevated)] text-xs text-[var(--color-text-tertiary)] truncate">
											{#if reply.replyToName}
												<span class="text-[var(--color-text-secondary)]">↩ {reply.replyToName}</span>
												{#if reply.quote}<span> · </span>{/if}
											{/if}
											{#if reply.quote}
												<span class="italic">"{reply.quote}"</span>
											{/if}
										</div>
									{/if}

									<!-- Attachment rendering -->
									{#if msg.attachment}
										{#if msg.attachment.type === 'image'}
											<button
												class="mt-1 mb-1 block cursor-pointer"
												onclick={() => expandedImage = msg.attachment?.url ?? null}
											>
												<img
													src={msg.attachment.url}
													alt={msg.attachment.description || 'Image'}
													class="max-w-xs max-h-48 rounded-lg border border-[var(--color-border)] object-cover"
													loading="lazy"
												/>
											</button>
										{:else if msg.attachment.type === 'voice'}
											<div class="mt-1 mb-1">
												<audio controls preload="none" class="w-full max-w-sm h-8">
													<source src={msg.attachment.url} type="audio/ogg" />
												</audio>
												{#if msg.attachment.transcript}
													<p class="text-xs text-[var(--color-text-tertiary)] mt-1 italic">
														{msg.attachment.transcript.length > 200 ? msg.attachment.transcript.slice(0, 200) + '...' : msg.attachment.transcript}
													</p>
												{/if}
											</div>
										{:else if msg.attachment.type === 'video'}
											<!-- svelte-ignore a11y_media_has_caption -->
											<video controls preload="none" class="mt-1 mb-1 max-w-sm max-h-48 rounded-lg border border-[var(--color-border)]">
												<source src={msg.attachment.url} />
											</video>
										{:else}
											<a
												href={msg.attachment.url}
												download={msg.attachment.filename || true}
												class="mt-1 mb-1 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-elevated)] border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors text-xs"
											>
												<svg class="w-4 h-4 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
													<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
												</svg>
												<span class="text-[var(--color-text-primary)]">{msg.attachment.filename || 'Download file'}</span>
												{#if msg.attachment.fileSize}
													<span class="text-[var(--color-text-tertiary)]">{formatFileSize(msg.attachment.fileSize)}</span>
												{/if}
											</a>
										{/if}
									{/if}

									<!-- Markdown body — clamp + expand -->
									{#if bodyText}
										<div
											class="timeline-body prose-sm prose-mycelium text-[var(--color-text-secondary)]"
											class:clamped={longContent && !expanded}
										>
											{@html renderMarkdown(msg.id, bodyText)}
										</div>
										{#if longContent}
											<button
												class="mt-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
												onclick={() => toggleExpand(msg.id)}
												aria-expanded={expanded}
											>
												{expanded ? 'Show less' : 'Show more'}
											</button>
										{/if}
									{/if}
								</div>
							</article>
						{/each}
					</div>
				{/each}

				<div class="flex justify-center py-6">
					<button
						onclick={loadMore}
						disabled={loadingMore}
						class="btn-ghost text-xs px-4 py-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-text-tertiary)] transition-colors"
					>
						{loadingMore ? 'Loading...' : 'Load older messages'}
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.timeline-body {
		font-size: 0.875rem;
		line-height: 1.55;
		word-break: break-word;
	}
	/* Clamped state — caps the rendered markdown until "Show more" expands.
	   Uses max-height + line-clamp fallback so multi-paragraph posts get a
	   clean cut-off rather than mid-sentence truncation. */
	.timeline-body.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	/* Re-style markdown elements to match the existing portal palette. */
	.timeline-body :global(p)        { margin: 0 0 0.5em 0; }
	.timeline-body :global(p:last-child) { margin-bottom: 0; }
	.timeline-body :global(strong)   { color: var(--color-text-primary); font-weight: 600; }
	.timeline-body :global(em)       { font-style: italic; }
	.timeline-body :global(a)        { color: var(--color-accent-aurum); text-decoration: underline; }
	.timeline-body :global(a:hover)  { color: var(--color-text-primary); }
	.timeline-body :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8em;
		padding: 0.05em 0.3em;
		background: var(--color-elevated);
		border-radius: 4px;
	}
	.timeline-body :global(pre) {
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		padding: 0.6em 0.8em;
		overflow-x: auto;
		margin: 0.5em 0;
	}
	.timeline-body :global(pre code) {
		background: transparent;
		padding: 0;
	}
	.timeline-body :global(ul),
	.timeline-body :global(ol) { margin: 0.25em 0 0.5em 1.25em; }
	.timeline-body :global(li) { margin: 0.15em 0; }
	.timeline-body :global(blockquote) {
		border-left: 2px solid var(--color-border);
		margin: 0.5em 0;
		padding-left: 0.75em;
		color: var(--color-text-tertiary);
	}
	.timeline-body :global(h1),
	.timeline-body :global(h2),
	.timeline-body :global(h3) {
		font-weight: 600;
		color: var(--color-text-primary);
		margin: 0.5em 0 0.25em 0;
	}
	.timeline-body :global(h1) { font-size: 1.05em; }
	.timeline-body :global(h2) { font-size: 1.0em; }
	.timeline-body :global(h3) { font-size: 0.95em; }

	/* Visible focus rings for keyboard nav. The pill buttons inherit
	   their default styles from .tag, which doesn't expose a focus
	   state — without this the source/channel filter is invisible when
	   traversed via Tab. */
	button:focus-visible {
		outline: 2px solid var(--color-accent-aurum);
		outline-offset: 2px;
	}
</style>
