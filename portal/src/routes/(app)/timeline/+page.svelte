<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	interface Attachment {
		id: string;
		type: 'image' | 'voice' | 'video' | 'file';
		url: string;
		filename?: string;
		fileSize?: number;
		transcript?: string;
		description?: string;
	}

	interface TimelineMessage {
		id: string;
		role: 'user' | 'assistant';
		content: string;
		source: string;
		agent_id?: string;
		created_at: string;
		message_type?: string;
		attachment?: Attachment;
	}

	let messages = $state<TimelineMessage[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let sourceFilter = $state<string | null>(null);
	let expandedImage = $state<string | null>(null);

	const sources = ['telegram', 'discord', 'whatsapp', 'portal'];

	const sourceStyles: Record<string, { bg: string; text: string; label: string }> = {
		telegram: { bg: 'rgba(74,222,128,0.1)', text: 'var(--color-accent-jade)', label: 'TG' },
		discord: { bg: 'rgba(167,139,250,0.1)', text: 'var(--color-accent-amethyst)', label: 'DC' },
		whatsapp: { bg: 'rgba(229,184,76,0.1)', text: 'var(--color-accent-aurum)', label: 'WA' },
		portal: { bg: 'rgba(91,159,232,0.1)', text: 'var(--color-accent)', label: 'WB' },
	};

	onMount(async () => {
		await loadMessages();
		loading = false;
	});

	async function loadMessages(before?: string) {
		const params = new URLSearchParams({ limit: '50' });
		if (before) params.set('before', before);

		try {
			const res = await api(`/portal/messages?${params}`);
			if (res.ok) {
				const data = await res.json();
				const newMessages = data.messages || [];
				if (before) {
					messages = [...messages, ...newMessages];
				} else {
					messages = newMessages;
				}
			}
		} catch {}
	}

	async function loadMore() {
		if (loadingMore || messages.length === 0) return;
		loadingMore = true;
		const lastMsg = messages[messages.length - 1];
		await loadMessages(lastMsg.created_at);
		loadingMore = false;
	}

	const filteredMessages = $derived(
		sourceFilter
			? messages.filter(m => m.source === sourceFilter)
			: messages
	);

	// Group messages by date
	const groupedMessages = $derived.by(() => {
		const groups: Array<{ date: string; label: string; messages: TimelineMessage[] }> = [];
		let currentDate = '';
		const today = new Date().toDateString();
		const yesterday = new Date(Date.now() - 86400000).toDateString();

		for (const msg of filteredMessages) {
			const d = new Date(msg.created_at);
			const dateStr = d.toDateString();
			if (dateStr !== currentDate) {
				currentDate = dateStr;
				let label: string;
				if (dateStr === today) label = 'Today';
				else if (dateStr === yesterday) label = 'Yesterday';
				else label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
				groups.push({ date: dateStr, label, messages: [] });
			}
			groups[groups.length - 1].messages.push(msg);
		}
		return groups;
	});

	function formatTime(dateStr: string) {
		return new Date(dateStr).toLocaleTimeString('en-US', {
			hour: '2-digit', minute: '2-digit',
		});
	}

	function getSource(source: string) {
		return sourceStyles[source] || { bg: 'var(--color-elevated)', text: 'var(--color-text-secondary)', label: source?.slice(0, 2).toUpperCase() || '??' };
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<svelte:head>
	<title>Timeline - Mycelium</title>
</svelte:head>

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
	<!-- Filters -->
	<div class="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)]">
		<button
			onclick={() => sourceFilter = null}
			class="tag text-xs transition-colors"
			class:tag-azure={!sourceFilter}
		>
			All
		</button>
		{#each sources as s}
			<button
				onclick={() => sourceFilter = sourceFilter === s ? null : s}
				class="tag text-xs transition-colors"
				class:tag-azure={sourceFilter === s}
			>
				{s}
			</button>
		{/each}
		{#if messages.length > 0}
			<span class="ml-auto text-xs text-[var(--color-text-tertiary)]">
				{filteredMessages.length} messages
			</span>
		{/if}
	</div>

	<!-- Messages -->
	<div class="flex-1 overflow-y-auto px-6 py-4">
		{#if loading}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-[var(--color-text-tertiary)] text-sm animate-pulse">Loading timeline...</div>
			</div>
		{:else if filteredMessages.length === 0}
			<div class="flex items-center justify-center min-h-[200px]">
				<div class="text-center">
					<p class="text-[var(--color-text-tertiary)] text-sm">No messages yet</p>
					<p class="text-[var(--color-text-tertiary)] text-xs mt-1">Messages from all your channels will appear here</p>
				</div>
			</div>
		{:else}
			<div class="max-w-3xl mx-auto">
				{#each groupedMessages as group}
					<!-- Date header -->
					<div class="section-marker text-xs my-4">
						<span>{group.label}</span>
					</div>

					<div class="space-y-1">
						{#each group.messages as msg (msg.id)}
							{@const sc = getSource(msg.source)}
							<div class="flex gap-3 items-start rounded-lg px-3 py-2.5 -mx-3 hover:bg-[var(--color-hover)] transition-colors">
								<!-- Source badge -->
								<div
									class="w-9 h-9 rounded-lg flex items-center justify-center text-[0.65rem] font-mono font-medium flex-shrink-0 mt-0.5"
									style="background: {sc.bg}; color: {sc.text};"
								>
									{sc.label}
								</div>

								<!-- Content -->
								<div class="flex-1 min-w-0">
									<div class="flex items-baseline gap-2 mb-0.5">
										<span class="text-xs font-medium" style="color: {msg.role === 'assistant' ? 'var(--color-accent)' : 'var(--color-text-primary)'};">
											{msg.role === 'assistant' ? (msg.agent_id || 'agent') : 'you'}
										</span>
										<span class="text-[0.65rem] text-[var(--color-text-tertiary)]">{formatTime(msg.created_at)}</span>
										{#if msg.attachment}
											<span class="text-[0.6rem] text-[var(--color-text-tertiary)] uppercase tracking-wider">{msg.attachment.type}</span>
										{/if}
									</div>

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

									<!-- Text content -->
									{#if msg.content && (!msg.attachment || msg.attachment.type !== 'image' || msg.content !== msg.attachment.description)}
										<p class="text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap break-words leading-relaxed">
											{msg.content?.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content}
										</p>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/each}

				<!-- Load more -->
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
