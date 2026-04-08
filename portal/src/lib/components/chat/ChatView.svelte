<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import { chatMessages, connectionStatus, type ChatMessage } from '$lib/stores/chat';
	import { isSecureChannelConfigured } from '$lib/vps-identity';

	let messageInput = $state('');
	let messagesContainer: HTMLDivElement;
	let inputElement: HTMLTextAreaElement;

	const messages = $derived($chatMessages);
	const status = $derived($connectionStatus);
	const isStreaming = $derived(status === 'streaming' || status === 'connecting');

	onMount(async () => {
		await chatMessages.loadHistory();
		scrollToBottom();
	});

	async function scrollToBottom() {
		await tick();
		if (messagesContainer) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	async function sendMessage() {
		const text = messageInput.trim();
		if (!text || isStreaming) return;

		messageInput = '';

		// Add user message
		const userMsg: ChatMessage = {
			id: `user-${Date.now()}`,
			role: 'user',
			content: text,
			timestamp: Date.now(),
		};
		chatMessages.addMessage(userMsg);

		// Create placeholder assistant message
		const assistantId = `assistant-${Date.now()}`;
		const assistantMsg: ChatMessage = {
			id: assistantId,
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true,
		};
		chatMessages.addMessage(assistantMsg);

		await scrollToBottom();
		connectionStatus.setStatus('connecting');

		try {
			const handleEvent = (event: Record<string, unknown>) => {
				switch (event.type) {
					case 'stream_start':
						connectionStatus.setStatus('streaming');
						break;
					case 'text_delta':
						chatMessages.updateMessage(assistantId, {
							content: (messages.find(m => m.id === assistantId)?.content || '') + ((event.content as string) || (event.text as string) || ''),
						});
						scrollToBottom();
						break;
					case 'thinking_delta':
						chatMessages.updateMessage(assistantId, {
							thinking: (messages.find(m => m.id === assistantId)?.thinking || '') + ((event.content as string) || (event.text as string) || ''),
						});
						break;
					case 'tool_start':
						chatMessages.updateMessage(assistantId, {
							toolsInProgress: [
								...(messages.find(m => m.id === assistantId)?.toolsInProgress || []),
								(event.name as string) || (event.tool as string) || 'tool',
							],
						});
						break;
					case 'tool_complete': {
						const cur = messages.find(m => m.id === assistantId);
						const tn = (event.name as string) || (event.tool as string) || 'tool';
						chatMessages.updateMessage(assistantId, {
							toolsInProgress: (cur?.toolsInProgress || []).filter(t => t !== tn),
							toolsUsed: [...(cur?.toolsUsed || []), tn],
						});
						break;
					}
					case 'usage':
						chatMessages.updateMessage(assistantId, {
							tokenUsage: { inputTokens: (event.inputTokens as number) || 0, outputTokens: (event.outputTokens as number) || 0, cost: ((event.inputTokens as number || 0) / 1_000_000) * 3 + ((event.outputTokens as number || 0) / 1_000_000) * 15 },
						});
						break;
					case 'done':
						chatMessages.updateMessage(assistantId, { isStreaming: false });
						break;
					case 'error':
						chatMessages.updateMessage(assistantId, {
							content: (messages.find(m => m.id === assistantId)?.content || '') + `\n\n*Error: ${event.error || event.message}*`,
							isStreaming: false,
						});
						break;
				}
			};

			if (isSecureChannelConfigured()) {
				const { getChannel } = await import('$lib/secure-channel');
				const channel = getChannel();
				connectionStatus.setStatus('streaming');
				await channel.requestStream('chat', { message: text }, (chunk) => {
					handleEvent(chunk as Record<string, unknown>);
				});
				chatMessages.updateMessage(assistantId, { isStreaming: false });
			} else {
				const csrfMatch = document.cookie.match(/mycelium_csrf=([^;]+)/);
				const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
				if (csrfMatch) chatHeaders['X-CSRF-Token'] = csrfMatch[1];

				const response = await fetch('/portal/chat/stream', {
					method: 'POST',
					headers: chatHeaders,
					credentials: 'same-origin',
					body: JSON.stringify({ message: text }),
				});

				if (!response.ok) {
					const err = await response.text().catch(() => 'Stream failed');
					chatMessages.updateMessage(assistantId, { content: `Error: ${err}`, isStreaming: false });
					connectionStatus.setStatus('error');
					return;
				}

				connectionStatus.setStatus('streaming');
				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';
					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						try { handleEvent(JSON.parse(line.slice(6))); }
						catch { /* skip malformed */ }
					}
				}
				chatMessages.updateMessage(assistantId, { isStreaming: false });
			}

			connectionStatus.setStatus('idle');
		} catch (e) {
			chatMessages.updateMessage(assistantId, {
				content: `Connection error: ${e instanceof Error ? e.message : 'Unknown'}`,
				isStreaming: false,
			});
			connectionStatus.setStatus('error');
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function renderMarkdown(content: string): string {
		if (!content) return '';
		const raw = marked.parse(content, { async: false }) as string;
		return DOMPurify.sanitize(raw);
	}
</script>

<div class="flex flex-col h-full">
	<!-- Messages -->
	<div bind:this={messagesContainer} class="flex-1 overflow-y-auto px-6 py-4 space-y-4">
		{#if messages.length === 0}
			<div class="flex-1 flex items-center justify-center min-h-[400px]">
				<div class="text-center">
					<p class="text-[var(--color-text-tertiary)] text-sm">Start a conversation</p>
				</div>
			</div>
		{/if}

		{#each messages as msg (msg.id)}
			<div class="flex gap-3 {msg.role === 'user' ? 'flex-row-reverse' : ''}">
				<!-- Avatar -->
				<div
					class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-medium {msg.role === 'assistant' ? 'bg-[rgba(91,159,232,0.2)] text-azure' : 'bg-[rgba(229,184,76,0.2)] text-aurum'}"
				>
					{msg.role === 'assistant' ? 'M' : 'U'}
				</div>

				<!-- Message bubble -->
				<div
					class="max-w-[75%] rounded-xl px-4 py-3 {msg.role === 'assistant' ? 'bg-[var(--color-surface)] border border-[var(--color-border)]' : 'bg-[rgba(91,159,232,0.1)]'}"
				>
					{#if msg.thinking}
						<details class="mb-2">
							<summary class="text-xs text-[var(--color-text-tertiary)] cursor-pointer hover:text-[var(--color-text-secondary)]">
								Thinking...
							</summary>
							<div class="mt-1 text-xs text-[var(--color-text-tertiary)] whitespace-pre-wrap">
								{msg.thinking}
							</div>
						</details>
					{/if}

					{#if msg.toolsInProgress && msg.toolsInProgress.length > 0}
						<div class="mb-2 flex flex-wrap gap-1">
							{#each msg.toolsInProgress as tool}
								<span class="tag-azure text-xs animate-pulse">{tool}</span>
							{/each}
						</div>
					{/if}

					<div class="prose prose-sm prose-dark max-w-none text-sm">
						{#if msg.role === 'assistant'}
							{@html renderMarkdown(msg.content)}
						{:else}
							<p>{msg.content}</p>
						{/if}
					</div>

					{#if msg.isStreaming && !msg.content}
						<div class="flex gap-1 py-1">
							<div class="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-bounce" style="animation-delay: 0ms"></div>
							<div class="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-bounce" style="animation-delay: 150ms"></div>
							<div class="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-bounce" style="animation-delay: 300ms"></div>
						</div>
					{/if}

					{#if msg.toolsUsed && msg.toolsUsed.length > 0}
						<div class="mt-2 flex flex-wrap gap-1">
							{#each msg.toolsUsed as tool}
								<span class="tag text-xs">{tool}</span>
							{/each}
						</div>
					{/if}

					{#if msg.tokenUsage}
						<div class="mt-1 text-xs text-[var(--color-text-tertiary)]">
							{msg.tokenUsage.inputTokens + msg.tokenUsage.outputTokens} tokens
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<!-- Input -->
	<div class="border-t border-[var(--color-border)] px-6 py-4">
		<div class="flex gap-3 items-end">
			<textarea
				bind:this={inputElement}
				bind:value={messageInput}
				onkeydown={handleKeydown}
				placeholder={isStreaming ? "Type your next message..." : "Send a message..."}
				rows={1}
				class="input flex-1 resize-none min-h-[44px] max-h-[200px]"
			></textarea>
			<button
				onclick={sendMessage}
				disabled={isStreaming || !messageInput.trim()}
				class="btn btn-primary px-4 py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{#if isStreaming}
					<svg class="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
				{:else}
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
					</svg>
				{/if}
			</button>
		</div>
		{#if status === 'error'}
			<p class="text-xs text-coral mt-2">Connection error. Try again.</p>
		{/if}
	</div>
</div>
