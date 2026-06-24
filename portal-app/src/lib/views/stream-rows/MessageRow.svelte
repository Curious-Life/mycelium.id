<script lang="ts">
	// One message row in the unified river. Extracted verbatim from TimelineView so
	// the rich rendering (brand badge · speaker · channel · reply · attachments ·
	// clamped markdown) is preserved. The image lightbox is owned by the river
	// (StreamRiver) — this row bubbles a click up via `onImage`.
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import {
		parseSource, getSourceStyle, classifySpeaker,
		extractReplyContext, stripAttachmentPlaceholder,
		formatTime, formatFileSize, formatChannelLabel,
		type TimelineMessage, type AgentInfo, type OwnerIdentity,
	} from '$lib/timeline/utils';

	marked.use({ breaks: true, gfm: true });

	let { msg, agentMap, owner, onImage }: {
		msg: TimelineMessage;
		agentMap: Map<string, AgentInfo>;
		owner: OwnerIdentity;
		onImage: (url: string) => void;
	} = $props();

	let expanded = $state(false);

	const renderedHtml = new Map<string, string>();
	function renderMarkdown(id: string, content: string): string {
		const cached = renderedHtml.get(id);
		if (cached !== undefined) return cached;
		const raw = marked.parse(content, { async: false }) as string;
		const safe = DOMPurify.sanitize(raw);
		if (renderedHtml.size > 500) {
			const oldest = renderedHtml.keys().next().value;
			if (oldest) renderedHtml.delete(oldest);
		}
		renderedHtml.set(id, safe);
		return safe;
	}
	function isLong(content: string): boolean {
		return content.length > 500 || content.split('\n').length > 6;
	}

	const parsed = $derived(parseSource(msg.source));
	const sc = $derived(getSourceStyle(parsed.platform));
	const speaker = $derived(classifySpeaker(msg, owner, agentMap));
	const reply = $derived(extractReplyContext(msg.content));
	const channelLabel = $derived(formatChannelLabel(msg.source, msg.channel || reply.groupTitle));
	const bodyText = $derived(stripAttachmentPlaceholder(reply.body, msg.attachment));
	const longContent = $derived(isLong(bodyText));
</script>

<article
	class="flex gap-2 sm:gap-3 items-start rounded-lg px-2 sm:px-3 py-2.5 -mx-2 sm:-mx-3 hover:bg-[var(--color-hover)] transition-colors"
	aria-label={`${speaker.label} via ${sc.title}${channelLabel ? ` in ${channelLabel}` : ''} at ${formatTime(msg.created_at)}`}
>
	<div
		class="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
		style="background: {sc.bg}; color: {sc.text};"
		title={sc.title}
	>
		<svg viewBox="0 0 24 24" class="w-4 h-4 sm:w-[18px] sm:h-[18px]" fill="currentColor" aria-hidden="true">
			<path d={sc.iconPath} />
		</svg>
	</div>

	<div class="flex-1 min-w-0">
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

		{#if msg.attachment}
			{#if msg.attachment.type === 'image'}
				<button class="mt-1 mb-1 block cursor-pointer" onclick={() => msg.attachment?.url && onImage(msg.attachment.url)}>
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
					onclick={() => (expanded = !expanded)}
					aria-expanded={expanded}
				>
					{expanded ? 'Show less' : 'Show more'}
				</button>
			{/if}
		{/if}
	</div>
</article>

<style>
	.timeline-body.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 6;
		line-clamp: 6;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
</style>
