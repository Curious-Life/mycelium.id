<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import JSZip from 'jszip';
	import { chatMessages, connectionStatus, type ChatMessage } from '$lib/stores/chat';
	import { apiPostForm, apiGet } from '$lib/api';
	import { toasts } from '$lib/stores/toast';
	import { browser } from '$app/environment';

	interface Props {
		visible?: boolean;
	}

	interface AgentInfo {
		id: string;
		name: string;
		color: string;
		role: string;
		status: string;
	}

	let { visible = true }: Props = $props();

	const connectionStatusValue = $derived($connectionStatus);

	// Agent selection
	let agents = $state<AgentInfo[]>([]);
	let selectedAgentId = $state<string | null>(null);
	let showAgentMenu = $state(false);

	const selectedAgent = $derived(agents.find(a => a.id === selectedAgentId) || agents.find(a => a.id === 'personal-agent') || agents[0] || null);

	const agentColorMap: Record<string, string> = {
		azure: '#5B9FE8', jade: '#4ADE80', coral: '#F87171',
		amethyst: '#A78BFA', aurum: '#E5B84C',
	};

	async function loadAgents() {
		try {
			const data = await apiGet<{ agents: AgentInfo[] }>('/portal/agents');
			agents = data.agents;
		} catch { /* ignore */ }
	}

	async function switchAgent(agentId: string) {
		if (agentId === selectedAgentId) { showAgentMenu = false; return; }
		selectedAgentId = agentId;
		showAgentMenu = false;
		if (browser) localStorage.setItem('mycelium-chat-agent', agentId);
		// Reload history for selected agent
		chatMessages.clear();
		await chatMessages.loadHistory(true, agentId);
	}

	// Local state
	let message = $state('');
	let isLoading = $state(false);
	let inputRef: HTMLTextAreaElement;
	let messagesContainerRef = $state<HTMLDivElement | null>(null);
	let abortController = $state<AbortController | null>(null);
	let enableThinking = $state(true);

	// Track which user messages are expanded
	let expandedMessages = $state<Set<string>>(new Set());
	// Track which thinking blocks are expanded
	let expandedThinking = $state<Set<string>>(new Set());
	// Track copied message feedback
	let copiedMessageId = $state<string | null>(null);

	// File upload state
	let pendingFiles = $state<File[]>([]);
	let uploadingFiles = $state(false);
	let fileInputRef = $state<HTMLInputElement | null>(null);
	let isDragOverChat = $state(false);

	// Hover state
	let isHovered = $state(false);
	// Expanded view state
	let isExpanded = $state(false);
	// History loading flag
	let isLoadingHistory = $state(false);
	// Track user scroll
	let userHasScrolled = $state(false);

	// Resizable chat dimensions
	let chatWidth = $state(720);
	let chatHeight = $state(550);
	let isResizing = $state(false);
	let resizeEdge = $state<'top' | 'left' | 'right' | 'top-left' | 'top-right' | null>(null);

	// Dragging state
	let isDragging = $state(false);
	let dragOffset = $state({ x: 0, y: 0 });

	// Position state - null means centered (default)
	let position = $state<{ x: number; y: number } | null>(null);

	function clampToViewport() {
		if (!position) return;
		const effectiveWidth = Math.min(chatWidth, window.innerWidth - 32);
		const maxX = window.innerWidth - effectiveWidth - 16;
		const minY = 16;
		const maxY = window.innerHeight - 60 - 16;

		const clampedX = Math.max(16, Math.min(maxX, position.x));
		const clampedY = Math.max(minY, Math.min(maxY, position.y));

		if (clampedX !== position.x || clampedY !== position.y) {
			position = { x: clampedX, y: clampedY };
			savePosition();
		}
	}

	// Load position from localStorage
	$effect(() => {
		if (browser) {
			const saved = localStorage.getItem('mycelium-chat-position');
			if (saved) {
				try {
					const parsed = JSON.parse(saved);
					const effectiveWidth = Math.min(chatWidth, window.innerWidth - 32);
					const maxX = window.innerWidth - effectiveWidth - 16;
					const maxY = window.innerHeight - 60 - 16;
					if (parsed.x >= 16 && parsed.x <= maxX && parsed.y >= 16 && parsed.y <= maxY) {
						position = parsed;
					}
				} catch { /* ignore */ }
			}

			const handleResize = () => clampToViewport();
			window.addEventListener('resize', handleResize);
			return () => window.removeEventListener('resize', handleResize);
		}
	});

	function savePosition() {
		if (browser && position) {
			localStorage.setItem('mycelium-chat-position', JSON.stringify(position));
		}
	}

	function saveChatSize() {
		if (browser) {
			localStorage.setItem('mycelium-chat-size', JSON.stringify({ width: chatWidth, height: chatHeight }));
		}
	}

	// Load saved chat size
	$effect(() => {
		if (browser) {
			const saved = localStorage.getItem('mycelium-chat-size');
			if (saved) {
				try {
					const parsed = JSON.parse(saved);
					if (parsed.width >= 320 && parsed.width <= 1200) chatWidth = parsed.width;
					if (parsed.height >= 200 && parsed.height <= window.innerHeight - 100) chatHeight = parsed.height;
				} catch { /* ignore */ }
			}
		}
	});

	// Resize handlers
	function startResize(edge: 'top' | 'left' | 'right' | 'top-left' | 'top-right') {
		return (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			isResizing = true;
			resizeEdge = edge;

			const startX = e.clientX;
			const startY = e.clientY;
			const startWidth = chatWidth;
			const startHeight = chatHeight;

			function onMouseMove(e: MouseEvent) {
				if (!isResizing) return;
				if (resizeEdge === 'left' || resizeEdge === 'top-left') {
					const dx = startX - e.clientX;
					chatWidth = Math.max(320, Math.min(1200, startWidth + dx));
				}
				if (resizeEdge === 'right' || resizeEdge === 'top-right') {
					const dx = e.clientX - startX;
					chatWidth = Math.max(320, Math.min(1200, startWidth + dx));
				}
				if (resizeEdge === 'top' || resizeEdge === 'top-left' || resizeEdge === 'top-right') {
					const dy = startY - e.clientY;
					chatHeight = Math.max(200, Math.min(window.innerHeight - 100, startHeight + dy));
				}
			}

			function onMouseUp() {
				isResizing = false;
				resizeEdge = null;
				saveChatSize();
				window.removeEventListener('mousemove', onMouseMove);
				window.removeEventListener('mouseup', onMouseUp);
			}

			window.addEventListener('mousemove', onMouseMove);
			window.addEventListener('mouseup', onMouseUp);
		};
	}

	function isNearBottom(): boolean {
		if (!messagesContainerRef) return true;
		return Math.abs(messagesContainerRef.scrollTop) < 50;
	}

	function handleMessagesScroll() {
		if (!messagesContainerRef) return;
		userHasScrolled = !isNearBottom();
	}

	// Auto-scroll for new messages
	$effect(() => {
		const msgCount = $chatMessages.length;
		if (msgCount > 0 && !isLoadingHistory) {
			userHasScrolled = false;
			setTimeout(() => {
				if (messagesContainerRef) {
					messagesContainerRef.scrollTop = 0;
				}
			}, 50);
		}
	});

	// Scroll during streaming
	$effect(() => {
		const msgs = $chatMessages;
		const streamingMsg = msgs.find((m) => m.isStreaming);
		if (streamingMsg && messagesContainerRef && !userHasScrolled) {
			messagesContainerRef.scrollTop = 0;
		}
	});

	// Immediately upload files through the pipeline (R2 + document + embedding)
	async function uploadFiles(files: File[]) {
		if (files.length === 0) return;
		uploadingFiles = true;
		pendingFiles = [...files];
		let successCount = 0;
		let failCount = 0;
		let importResult: { type: string; imported: number; skipped: number; stats?: Record<string, number> } | null = null;
		for (let i = 0; i < files.length; i++) {
			let file = files[i];
			try {
				// Large ZIPs (>90MB): extract just JSON/MD to avoid Cloudflare 100MB limit
				if (file.size > 90_000_000 && file.name.endsWith('.zip')) {
					try {
						const buf = await file.arrayBuffer();
						const zip = await JSZip.loadAsync(buf);
						const dataFiles = Object.keys(zip.files).filter(n => !zip.files[n].dir && (n.endsWith('.json') || n.endsWith('.md')));
						if (dataFiles.length > 0) {
							const newZip = new JSZip();
							for (const name of dataFiles) {
								newZip.file(name, await zip.files[name].async('uint8array'));
							}
							const blob = await newZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
							file = new File([blob], file.name, { type: 'application/zip' });
						}
					} catch { /* fall through with original file */ }
				}
				const formData = new FormData();
				formData.append('file', file);
				const res = await apiPostForm<{ attachmentId: string; type: string; content: string; filename: string; importResult?: { type: string; imported: number; skipped: number; stats?: Record<string, number> } }>('/portal/upload', formData);
				pendingFiles = pendingFiles.filter(f => f !== file);
				if (res.importResult) {
					importResult = res.importResult;
				}
				successCount++;
			} catch (e) {
				console.error('[Chat] File upload failed:', e);
				pendingFiles = pendingFiles.filter(f => f !== file);
				failCount++;
				toasts.error(`Failed to upload ${file.name}`);
			}
		}
		uploadingFiles = false;
		if (importResult) {
			const s = importResult.stats;
			let msg: string;
			if (importResult.type === 'claude' && s) {
				const parts: string[] = [];
				if (s.messages) parts.push(`${s.messages} messages from ${s.conversations} conversations`);
				if (s.skipped_duplicates) parts.push(`${s.skipped_duplicates} duplicates skipped`);
				if (s.artifacts_deduplicated) parts.push(`${s.artifacts_kept} artifacts kept, ${s.artifacts_deduplicated} deduplicated`);
				if (s.projects) parts.push(`${s.projects} projects, ${s.project_docs} docs`);
				if (s.memories) parts.push(`${s.memories} memories`);
				msg = `Claude import: ${parts.join(' · ')}`;
			} else if (importResult.type === 'chatgpt' && s) {
				const parts: string[] = [];
				if (s.messages) parts.push(`${s.messages} messages from ${s.conversations} conversations`);
				if (s.skipped_duplicates) parts.push(`${s.skipped_duplicates} duplicates skipped`);
				msg = `ChatGPT import: ${parts.join(' · ')}`;
			} else if (importResult.type === 'obsidian') {
				msg = importResult.skipped > 0
					? `Obsidian vault: ${importResult.imported} imported, ${importResult.skipped} skipped`
					: `Obsidian vault: ${importResult.imported} notes imported`;
			} else {
				const label = `${importResult.type} export`;
				msg = importResult.skipped > 0
					? `${label}: ${importResult.imported} imported, ${importResult.skipped} skipped`
					: `${label}: ${importResult.imported} items imported`;
			}
			toasts.success(msg);
		} else if (successCount > 0) {
			const msg = successCount === 1 && failCount === 0
				? `${files[0].name} uploaded`
				: `${successCount} file${successCount > 1 ? 's' : ''} uploaded`;
			toasts.success(msg);
		}
	}

	async function sendMessage() {
		if (!message.trim() || isLoading) return;

		isExpanded = true;

		const userMessage = message.trim();
		const userMsgId = `user-${Date.now()}`;
		const assistantMsgId = `assistant-${Date.now()}`;

		chatMessages.addMessage({
			id: userMsgId,
			role: 'user',
			content: userMessage,
			timestamp: Date.now()
		});

		message = '';
		if (inputRef) inputRef.style.height = 'auto';
		isLoading = true;

		abortController = new AbortController();

		chatMessages.addMessage({
			id: assistantMsgId,
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true
		});

		connectionStatus.setStatus('connecting');

		try {
			const res = await fetch('/portal/chat/stream', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					message: userMessage,
					enableThinking,
					...(selectedAgentId ? { agentId: selectedAgentId } : {}),
				}),
				signal: abortController.signal
			});

			if (!res.ok) {
				const text = await res.text();
				let errorMsg = `Server error (${res.status})`;
				try {
					const data = JSON.parse(text);
					errorMsg = data.error || data.message || errorMsg;
				} catch {
					if (text.includes('Agent not configured')) errorMsg = 'Agent not configured';
					else if (text.includes('Session expired')) errorMsg = 'Session expired';
					else if (text.includes('auth failed')) errorMsg = 'Agent auth failed';
					else if (res.status === 502) errorMsg = 'Could not reach agent server';
				}
				throw new Error(errorMsg);
			}

			connectionStatus.setStatus('streaming');

			const reader = res.body?.getReader();
			if (!reader) throw new Error('No response body');

			const decoder = new TextDecoder();
			let buffer = '';
			let content = '';
			let thinking = '';
			let toolsInProgress: string[] = [];
			let usage: { inputTokens: number; outputTokens: number; cost: number } | undefined;
			let thinkingTokens = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6);
					if (data === '[DONE]') continue;

					try {
						const event = JSON.parse(data);

						switch (event.type) {
							case 'text_delta':
								content += event.content || event.text || '';
								chatMessages.updateMessage(assistantMsgId, { content });
								break;

							case 'thinking_start':
								thinking = '';
								break;

							case 'thinking_delta':
								thinking += event.content || event.text || '';
								chatMessages.updateMessage(assistantMsgId, { thinking });
								break;

							case 'thinking_end':
								break;

							case 'tool_start':
								toolsInProgress = [...toolsInProgress, event.name || event.tool || 'tool'];
								chatMessages.updateMessage(assistantMsgId, { toolsInProgress });
								break;

							case 'tool_complete':
							case 'tool_error':
								toolsInProgress = toolsInProgress.filter((t) => t !== (event.name || event.tool));
								chatMessages.updateMessage(assistantMsgId, { toolsInProgress });
								break;

							case 'usage':
								usage = {
									inputTokens: event.inputTokens,
									outputTokens: event.outputTokens,
									cost: (event.inputTokens / 1_000_000) * 3 + (event.outputTokens / 1_000_000) * 15
								};
								thinkingTokens = event.thinkingTokens || 0;
								break;

							case 'done':
								chatMessages.updateMessage(assistantMsgId, {
									isStreaming: false,
									toolsInProgress: [],
									toolsUsed: event.toolsUsed || [],
									tokenUsage: usage,
									thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined
								});
								break;

							case 'error':
								if (content) {
									content += `\n\n*Error: ${event.message}*`;
									chatMessages.updateMessage(assistantMsgId, { content });
								} else {
									throw new Error(event.message);
								}
								break;
						}
					} catch (e) {
						if (e instanceof SyntaxError) continue;
						throw e;
					}
				}
			}

			chatMessages.updateMessage(assistantMsgId, {
				isStreaming: false,
				toolsInProgress: []
			});

			connectionStatus.setStatus('idle');
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') {
				chatMessages.updateMessage(assistantMsgId, {
					content: content || '[Cancelled]',
					isStreaming: false,
					toolsInProgress: []
				});
				connectionStatus.setStatus('idle');
			} else {
				chatMessages.updateMessage(assistantMsgId, {
					content: `Error: ${e instanceof Error ? e.message : 'Something went wrong'}`,
					isStreaming: false,
					toolsInProgress: []
				});
				connectionStatus.setStatus('error');
			}
		} finally {
			isLoading = false;
			abortController = null;
		}
	}

	function cancelStream() {
		if (abortController) abortController.abort();
	}

	function clearHistory() {
		if (abortController) abortController.abort();
		chatMessages.clear();
		connectionStatus.reset();
		isExpanded = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			if (e.shiftKey) return;
			e.preventDefault();
			sendMessage();
		}
		if (e.key === 'Escape' && $chatMessages.length > 0) {
			clearHistory();
		}
		if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
			e.stopPropagation();
		}
	}

	function renderMarkdown(content: string): string {
		return DOMPurify.sanitize(marked(content) as string);
	}

	function toggleMessageExpanded(msgId: string) {
		const newSet = new Set(expandedMessages);
		if (newSet.has(msgId)) newSet.delete(msgId);
		else newSet.add(msgId);
		expandedMessages = newSet;
	}

	function toggleThinkingExpanded(msgId: string) {
		const newSet = new Set(expandedThinking);
		if (newSet.has(msgId)) newSet.delete(msgId);
		else newSet.add(msgId);
		expandedThinking = newSet;
	}

	async function copyMessageContent(msgId: string, content: string) {
		try {
			await navigator.clipboard.writeText(content);
			copiedMessageId = msgId;
			setTimeout(() => {
				if (copiedMessageId === msgId) copiedMessageId = null;
			}, 2000);
		} catch { /* ignore */ }
	}

	function needsTruncation(content: string): boolean {
		const newlineCount = (content.match(/\n/g) || []).length;
		return content.length > 240 || newlineCount >= 4;
	}

	function formatSource(source: string | undefined): string | null {
		if (!source) return null;
		switch (source) {
			case 'telegram':
			case 'web':
			case 'portal':
				return null;
			case 'import_claude':
				return 'Claude';
			case 'import_chatgpt':
				return 'ChatGPT';
			default:
				return source.replace(/_/g, ' ');
		}
	}

	// Auto-resize textarea
	function handleInput() {
		if (!inputRef) return;
		inputRef.style.height = 'auto';
		const maxHeight = Math.floor(window.innerHeight * 0.5);
		const newHeight = Math.min(inputRef.scrollHeight, maxHeight);
		inputRef.style.height = `${newHeight}px`;
	}

	// File handling — full-page drop zone
	let dragCounter = 0;

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			uploadFiles(Array.from(input.files));
			input.value = '';
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of items) {
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length > 0) {
			e.preventDefault();
			uploadFiles(files);
		}
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	// Window-level drag listeners for full-page drop zone
	$effect(() => {
		if (!browser) return;

		function onDragEnter(e: DragEvent) {
			e.preventDefault();
			if (e.dataTransfer?.types?.includes('Files')) {
				dragCounter++;
				isDragOverChat = true;
			}
		}

		function onDragOver(e: DragEvent) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		}

		function onDragLeave(e: DragEvent) {
			e.preventDefault();
			dragCounter--;
			if (dragCounter <= 0) {
				dragCounter = 0;
				isDragOverChat = false;
			}
		}

		function onDrop(e: DragEvent) {
			e.preventDefault();
			dragCounter = 0;
			isDragOverChat = false;
			if (e.dataTransfer?.files?.length) {
				uploadFiles(Array.from(e.dataTransfer.files));
			}
		}

		window.addEventListener('dragenter', onDragEnter);
		window.addEventListener('dragover', onDragOver);
		window.addEventListener('dragleave', onDragLeave);
		window.addEventListener('drop', onDrop);

		return () => {
			window.removeEventListener('dragenter', onDragEnter);
			window.removeEventListener('dragover', onDragOver);
			window.removeEventListener('dragleave', onDragLeave);
			window.removeEventListener('drop', onDrop);
		};
	});

	// Drag handlers
	function startDrag(e: MouseEvent) {
		e.preventDefault();
		isDragging = true;
		const inputBar = (e.currentTarget as HTMLElement).closest('.glass-box') as HTMLElement;
		const rect = inputBar.getBoundingClientRect();
		dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
		window.addEventListener('mousemove', onDrag);
		window.addEventListener('mouseup', stopDrag);
	}

	function onDrag(e: MouseEvent) {
		if (!isDragging) return;
		const newX = e.clientX - dragOffset.x;
		const inputBarY = e.clientY - dragOffset.y;
		const cw = Math.min(720, window.innerWidth - 32);
		const maxX = window.innerWidth - cw - 16;
		const minY = 16;
		const maxY = window.innerHeight - 60 - 16;
		position = {
			x: Math.max(16, Math.min(maxX, newX)),
			y: Math.max(minY, Math.min(maxY, inputBarY))
		};
	}

	function stopDrag() {
		isDragging = false;
		savePosition();
		window.removeEventListener('mousemove', onDrag);
		window.removeEventListener('mouseup', stopDrag);
	}

	// Touch drag
	function startTouchDrag(e: TouchEvent) {
		if (e.touches.length !== 1) return;
		e.preventDefault();
		isDragging = true;
		const touch = e.touches[0];
		const inputBar = (e.currentTarget as HTMLElement).closest('.glass-box') as HTMLElement;
		const rect = inputBar.getBoundingClientRect();
		dragOffset = { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
		window.addEventListener('touchmove', onTouchDrag, { passive: false });
		window.addEventListener('touchend', stopTouchDrag);
		window.addEventListener('touchcancel', stopTouchDrag);
	}

	function onTouchDrag(e: TouchEvent) {
		if (!isDragging || e.touches.length !== 1) return;
		e.preventDefault();
		const touch = e.touches[0];
		const newX = touch.clientX - dragOffset.x;
		const inputBarY = touch.clientY - dragOffset.y;
		const cw = Math.min(720, window.innerWidth - 32);
		const maxX = window.innerWidth - cw - 16;
		position = {
			x: Math.max(16, Math.min(maxX, newX)),
			y: Math.max(16, Math.min(window.innerHeight - 76, inputBarY))
		};
	}

	function stopTouchDrag() {
		isDragging = false;
		savePosition();
		window.removeEventListener('touchmove', onTouchDrag);
		window.removeEventListener('touchend', stopTouchDrag);
		window.removeEventListener('touchcancel', stopTouchDrag);
	}

	// Load agents and restore selection
	$effect(() => {
		if (browser) {
			const saved = localStorage.getItem('mycelium-chat-agent');
			if (saved) selectedAgentId = saved;
			loadAgents();
		}
	});

	const isMobile = browser && window.innerWidth < 768;

	const containerStyle = $derived(() => {
		if (position) {
			const bottomOffset = window.innerHeight - position.y - 60;
			return `left: ${position.x}px; bottom: ${Math.max(16, bottomOffset)}px; transform: none;`;
		}
		const defaultBottom = isMobile ? 80 : 24;
		return `left: 50%; bottom: ${defaultBottom}px; transform: translateX(-50%);`;
	});

	const statusColor = $derived(() => {
		switch (connectionStatusValue) {
			case 'connecting': return 'bg-yellow-500';
			case 'streaming': return 'bg-green-500';
			case 'error': return 'bg-red-500';
			default: return 'bg-gray-500';
		}
	});
</script>

{#snippet attachmentBlock(attachment: import('$lib/stores/chat').Attachment)}
	{#if attachment.type === 'image'}
		<img
			src={attachment.url}
			alt={attachment.description || 'Image'}
			class="max-w-[240px] max-h-[200px] rounded-lg cursor-pointer object-cover"
			onclick={() => window.open(attachment.url, '_blank')}
		/>
	{:else if attachment.type === 'voice'}
		<div class="flex items-center gap-2">
			<audio controls preload="none" class="w-full max-w-[240px] h-8">
				<source src={attachment.url} />
			</audio>
		</div>
		{#if attachment.transcript}
			<p class="text-xs text-[var(--color-text-tertiary)] mt-1 italic">"{attachment.transcript}"</p>
		{/if}
	{:else if attachment.type === 'video'}
		<video controls preload="none" class="max-w-[280px] max-h-[200px] rounded-lg">
			<source src={attachment.url} />
		</video>
	{:else}
		<a
			href={attachment.url}
			download={attachment.filename}
			class="inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors text-[var(--color-text-secondary)]"
		>
			<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
			</svg>
			{attachment.filename || 'Download file'}
			{#if attachment.fileSize}
				<span class="text-[var(--color-text-tertiary)]">({formatFileSize(attachment.fileSize)})</span>
			{/if}
		</a>
	{/if}
{/snippet}

{#if visible}
	<!-- Full-page drop overlay -->
	{#if isDragOverChat}
		<div class="drop-overlay-fullpage">
			<div class="drop-overlay-content">
				<svg class="w-12 h-12 text-azure" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
				</svg>
				<span class="text-lg text-[var(--color-text-primary)]">Drop files to attach</span>
				<span class="text-sm text-[var(--color-text-tertiary)]">Images, audio, video, documents</span>
			</div>
		</div>
	{/if}

	<!-- Chat container - draggable, remembers position -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="chat-container fixed flex flex-col gap-3 transition-all duration-150"
		class:dragging={isDragging}
		class:resizing={isResizing}
		style="z-index: 9999; width: min({chatWidth}px, calc(100vw - 32px)); {containerStyle()}"
		onmouseenter={() => isHovered = true}
		onmouseleave={() => isHovered = false}
	>
		<!-- Messages box -->
		{#if isExpanded}
			<div class="glass-box rounded-2xl shadow-2xl messages-box w-full flex flex-col" style="height: min({chatHeight}px, calc(100vh - 120px));">
				<!-- Resize handles -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="resize-handle resize-top" onmousedown={startResize('top')}></div>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="resize-handle resize-left" onmousedown={startResize('left')}></div>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="resize-handle resize-right" onmousedown={startResize('right')}></div>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="resize-handle resize-top-left" onmousedown={startResize('top-left')}></div>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="resize-handle resize-top-right" onmousedown={startResize('top-right')}></div>

				<!-- Header -->
				<div class="messages-header shrink-0">
					<!-- Agent selector -->
					<div class="relative mr-auto">
						<button
							onclick={() => showAgentMenu = !showAgentMenu}
							class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-white/10 transition-colors text-[var(--color-text-primary)]"
							title="Switch agent"
						>
							{#if selectedAgent}
								<div class="w-2 h-2 rounded-full" style="background-color: {agentColorMap[selectedAgent.color] || '#6B7280'};"></div>
								<span class="text-xs font-medium">{selectedAgent.name}</span>
							{:else}
								<span class="text-xs text-[var(--color-text-tertiary)]">Agent</span>
							{/if}
							<svg class="w-3 h-3 text-[var(--color-text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
							</svg>
						</button>
						{#if showAgentMenu}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="absolute top-full left-0 mt-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-xl z-50 py-1 min-w-[160px]"
								onmouseleave={() => showAgentMenu = false}
							>
								{#each agents.filter(a => a.status === 'online') as agent}
									<button
										onclick={() => switchAgent(agent.id)}
										class="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/10 transition-colors {agent.id === selectedAgentId ? 'text-[var(--color-text-primary)] font-medium' : 'text-[var(--color-text-secondary)]'}"
									>
										<div class="w-2 h-2 rounded-full flex-shrink-0" style="background-color: {agentColorMap[agent.color] || '#6B7280'};"></div>
										<span>{agent.name}</span>
										<span class="text-[10px] text-[var(--color-text-tertiary)] ml-auto">{agent.role}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>

					{#if connectionStatusValue !== 'idle'}
						<div class="flex items-center gap-2">
							<div class="w-2 h-2 rounded-full {statusColor()} animate-pulse"></div>
							<span class="text-[10px] text-[var(--color-text-tertiary)] capitalize">
								{connectionStatusValue}
							</span>
						</div>
					{/if}

					<!-- Thinking toggle -->
					<button
						onclick={() => (enableThinking = !enableThinking)}
						class="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
						class:text-azure={enableThinking}
						class:text-[var(--color-text-tertiary)]={!enableThinking}
						aria-label="Toggle thinking mode"
						title={enableThinking ? 'Thinking mode on' : 'Thinking mode off'}
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
							<path d="M12 2a10 10 0 0 1 7.38 16.75" />
							<path d="M12 6v6l4 2" />
							<path d="M2.5 8.875a10 10 0 0 0-.5 3" />
							<path d="M2.83 16a10 10 0 0 0 2.43 3.4" />
							<path d="M4.636 5.235a10 10 0 0 1 .891-.857" />
							<path d="M8.644 21.42a10 10 0 0 0 7.631-.38" />
						</svg>
					</button>

					<!-- Cancel button -->
					{#if isLoading && abortController}
						<button
							onclick={cancelStream}
							class="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-orange-400 hover:text-orange-300"
							aria-label="Cancel"
							title="Cancel streaming"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
							</svg>
						</button>
					{/if}

					<button
						onclick={clearHistory}
						class="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
						aria-label="Clear history"
						title="Clear chat"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				<!-- Messages area -->
				<div bind:this={messagesContainerRef} class="messages-scroll-area" onscroll={handleMessagesScroll}>
					<div class="messages-wrapper">
					{#if $chatMessages.length === 0 && !isLoadingHistory}
						<button
							onclick={async () => {
								isLoadingHistory = true;
								try {
									await chatMessages.loadHistory(false, selectedAgentId || undefined);
								} catch { /* ignore */ } finally {
									isLoadingHistory = false;
								}
							}}
							class="load-history-btn"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
							</svg>
							Load chat history
						</button>
					{:else if isLoadingHistory}
						<div class="load-history-btn loading">
							<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
							Loading history...
						</div>
					{/if}

					{#each $chatMessages as msg (msg.id)}
						<div class="message-item animate-slide-up" class:user={msg.role === 'user'}>
							{#if msg.role === 'user'}
								{@const isMsgExpanded = expandedMessages.has(msg.id)}
								{@const shouldTruncate = needsTruncation(msg.content)}
								<div class="flex justify-end">
									<div class="user-bubble">
										<p
											class="text-sm user-message-text"
											class:truncated={shouldTruncate && !isMsgExpanded}
										>
											{msg.content}
										</p>
										<div class="flex items-center justify-end gap-2 mt-1">
											{#if shouldTruncate}
												<button
													onclick={() => toggleMessageExpanded(msg.id)}
													class="view-all-btn"
												>
													{isMsgExpanded ? 'Show less' : 'View all'}
												</button>
											{/if}
											{#if formatSource(msg.source)}
												<span class="source-badge">{formatSource(msg.source)}</span>
											{/if}
										</div>
									</div>
									{#if msg.attachment}
										<div class="mt-2">
											{@render attachmentBlock(msg.attachment)}
										</div>
									{/if}
								</div>
							{:else}
								<!-- Assistant message -->
								<div class="flex items-start gap-2 max-w-full overflow-hidden">
									<div class="w-5 h-5 rounded-full bg-gradient-to-br from-azure to-amethyst flex items-center justify-center flex-shrink-0 mt-0.5">
										<svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
											<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
										</svg>
									</div>
									<div class="flex-1 min-w-0 overflow-hidden">
										<div class="flex items-center gap-2 mb-1">
											<span class="text-xs font-medium text-[var(--color-text-primary)]">mycelium</span>
											{#if formatSource(msg.source)}
												<span class="source-badge">{formatSource(msg.source)}</span>
											{/if}
											{#if msg.isStreaming}
												<span class="streaming-indicator"></span>
											{/if}
											{#if msg.tokenUsage}
												<span class="text-[10px] text-[var(--color-text-tertiary)] font-mono">
													{msg.tokenUsage.inputTokens.toLocaleString()}&#8593; {msg.tokenUsage.outputTokens.toLocaleString()}&#8595;
													{#if msg.thinkingTokens}
														<svg class="inline-block w-3 h-3 mx-0.5 opacity-60" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
															<path d="M12 2a10 10 0 0 1 7.38 16.75" />
															<path d="M12 6v6l4 2" />
															<path d="M2.5 8.875a10 10 0 0 0-.5 3" />
															<path d="M2.83 16a10 10 0 0 0 2.43 3.4" />
															<path d="M4.636 5.235a10 10 0 0 1 .891-.857" />
															<path d="M8.644 21.42a10 10 0 0 0 7.631-.38" />
														</svg>~{msg.thinkingTokens.toLocaleString()}
													{/if}
													${msg.tokenUsage.cost.toFixed(4)}
												</span>
											{/if}
										</div>

										<!-- Tools in progress -->
										{#if msg.toolsInProgress && msg.toolsInProgress.length > 0}
											<div class="flex flex-wrap gap-1 mb-2">
												{#each msg.toolsInProgress as tool}
													<span class="tool-badge">
														<span class="tool-spinner"></span>
														{tool}
													</span>
												{/each}
											</div>
										{/if}

										<!-- Thinking/tools indicator -->
										{#if msg.thinking || (msg.toolsUsed && msg.toolsUsed.length > 0)}
											{@const isThinkingExpanded = expandedThinking.has(msg.id)}
											<div class="thinking-indicator mb-1.5">
												<button
													onclick={() => toggleThinkingExpanded(msg.id)}
													class="thinking-toggle-inline"
												>
													<svg
														class="w-2.5 h-2.5 transition-transform opacity-60"
														class:rotate-90={isThinkingExpanded}
														fill="none"
														stroke="currentColor"
														viewBox="0 0 24 24"
													>
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
													</svg>
													<span class="text-[10px] text-[var(--color-text-tertiary)]">
														{#if msg.thinkingTokens}
															<svg class="inline-block w-3 h-3 mr-0.5 opacity-70" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
																<path d="M12 2a10 10 0 0 1 7.38 16.75" />
																<path d="M12 6v6l4 2" />
																<path d="M2.5 8.875a10 10 0 0 0-.5 3" />
																<path d="M2.83 16a10 10 0 0 0 2.43 3.4" />
																<path d="M4.636 5.235a10 10 0 0 1 .891-.857" />
																<path d="M8.644 21.42a10 10 0 0 0 7.631-.38" />
															</svg>~{msg.thinkingTokens}
														{/if}
														{#if msg.thinkingTokens && msg.toolsUsed?.length} &middot; {/if}
														{#if msg.toolsUsed?.length}used {msg.toolsUsed.join(', ')}{/if}
													</span>
												</button>
												{#if isThinkingExpanded && msg.thinking}
													<div class="thinking-content-expanded">
														{msg.thinking}
													</div>
												{/if}
											</div>
										{/if}

										<div class="prose prose-sm max-w-full chat-prose text-[var(--color-text-primary)]">
											{@html renderMarkdown(msg.content)}
										</div>

										{#if msg.attachment}
											<div class="mt-2">
												{@render attachmentBlock(msg.attachment)}
											</div>
										{/if}

										<!-- Copy button -->
										{#if !msg.isStreaming}
											<div class="flex justify-end mt-2">
												<button
													onclick={() => copyMessageContent(msg.id, msg.content)}
													class="copy-btn flex items-center gap-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
													title="Copy message"
												>
													{#if copiedMessageId === msg.id}
														<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
														</svg>
														<span>Copied</span>
													{:else}
														<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
														</svg>
														<span>Copy</span>
													{/if}
												</button>
											</div>
										{/if}
									</div>
								</div>
							{/if}
						</div>
					{/each}

					{#if isLoading && !$chatMessages.some((m) => m.isStreaming)}
						<div class="flex items-start gap-2 animate-pulse">
							<div class="w-5 h-5 rounded-full bg-gradient-to-br from-azure to-amethyst flex items-center justify-center flex-shrink-0">
								<svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
									<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
								</svg>
							</div>
							<div class="flex items-center gap-1 text-[var(--color-text-tertiary)]">
								<span class="text-xs">thinking</span>
								<span class="dots">...</span>
							</div>
						</div>
					{/if}
					</div>
				</div>
			</div>
		{/if}

		<!-- Upload progress strip -->
		{#if pendingFiles.length > 0 || uploadingFiles}
			<div class="file-preview-strip glass-box rounded-xl px-3 py-2 flex flex-wrap gap-2 items-center">
				{#each pendingFiles as file}
					<div class="file-chip uploading">
						<div class="w-3 h-3 border-2 border-azure border-t-transparent rounded-full animate-spin"></div>
						<span class="file-chip-name">{file.name}</span>
						<span class="file-chip-size">{formatFileSize(file.size)}</span>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Input bar -->
		<div class="input-bar glass-box flex items-center gap-3 px-4 py-3 shadow-xl rounded-xl min-w-0 shrink-0">
			<!-- Horizontal resize handles on input bar -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-left" onmousedown={startResize('left')}></div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-right" onmousedown={startResize('right')}></div>

			<!-- Drag handle -->
			<button
				onmousedown={startDrag}
				ontouchstart={startTouchDrag}
				class="p-1 hover:bg-white/10 rounded-lg transition-colors cursor-grab active:cursor-grabbing text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] shrink-0 touch-manipulation"
				aria-label="Drag to move"
				title="Drag to move chat"
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11" />
				</svg>
			</button>

			<!-- History/expand button -->
			<button
				onclick={async () => {
					if (isExpanded) {
						isExpanded = false;
					} else {
						isExpanded = true;
						if ($chatMessages.length === 0 && !isLoadingHistory) {
							isLoadingHistory = true;
							try {
								await chatMessages.loadHistory(true, selectedAgentId || undefined);
								setTimeout(() => {
									if (messagesContainerRef) messagesContainerRef.scrollTop = 0;
								}, 100);
							} catch { /* ignore */ } finally {
								isLoadingHistory = false;
							}
						} else {
							setTimeout(() => {
								if (messagesContainerRef) messagesContainerRef.scrollTop = 0;
							}, 50);
						}
					}
				}}
				class="p-1 hover:bg-white/10 rounded-lg transition-colors text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] shrink-0"
				aria-label={isExpanded ? "Close chat" : "View chat history"}
				title={isExpanded ? "Close chat" : "View chat history"}
			>
				<svg class="w-5 h-5 transition-transform" class:rotate-180={isExpanded} fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
				</svg>
			</button>

			<!-- File attach button -->
			<button
				onclick={() => fileInputRef?.click()}
				class="p-1 hover:bg-white/10 rounded-lg transition-colors text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] shrink-0"
				aria-label="Attach file"
				title="Attach file"
				disabled={isLoading}
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
				</svg>
			</button>
			<input
				bind:this={fileInputRef}
				type="file"
				onchange={handleFileSelect}
				multiple
				class="hidden"
			/>

			<textarea
				bind:this={inputRef}
				bind:value={message}
				onkeydown={handleKeydown}
				oninput={handleInput}
				onpaste={handlePaste}
				placeholder={isLoading ? "Type your next message..." : "Ask anything..."}
				rows="1"
				class="chat-input"
			></textarea>
			<button
				onclick={sendMessage}
				disabled={!message.trim() || isLoading}
				class="p-2 rounded-full bg-azure/20 text-azure hover:bg-azure/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
				aria-label="Send message"
			>
				{#if isLoading}
					<div class="w-5 h-5 border-2 border-azure border-t-transparent rounded-full animate-spin"></div>
				{:else}
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
					</svg>
				{/if}
			</button>
		</div>
	</div>
{/if}

<style>
	/* Glass effect */
	.glass-box {
		background: rgba(20, 20, 23, 0.75);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border: 1px solid rgba(255, 255, 255, 0.15);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
	}

	:global([data-theme='light']) .glass-box {
		background: rgba(255, 255, 255, 0.75);
		border-color: rgba(0, 0, 0, 0.1);
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
	}

	@supports not (backdrop-filter: blur(10px)) {
		.glass-box {
			background: rgba(20, 20, 23, 0.95);
		}
		:global([data-theme='light']) .glass-box {
			background: rgba(255, 255, 255, 0.95);
		}
	}

	.chat-container.dragging {
		transition: none;
	}

	.drop-overlay-fullpage {
		position: fixed;
		inset: 0;
		z-index: 99999;
		background: rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}

	:global([data-theme='light']) .drop-overlay-fullpage {
		background: rgba(255, 255, 255, 0.7);
	}

	.drop-overlay-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		padding: 3rem 4rem;
		border: 2px dashed var(--color-accent);
		border-radius: 1.5rem;
		background: rgba(var(--color-accent-rgb), 0.08);
	}

	.file-preview-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
	}

	.file-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		background: rgba(var(--color-accent-rgb), 0.15);
		border: 1px solid rgba(var(--color-accent-rgb), 0.25);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		max-width: 200px;
	}

	.file-chip.uploading {
		opacity: 0.6;
	}

	.file-chip-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 120px;
	}

	.file-chip-size {
		font-size: 0.625rem;
		color: var(--color-text-tertiary);
		white-space: nowrap;
	}

	.file-chip-remove {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.125rem;
		border-radius: 50%;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-tertiary);
		transition: color 0.15s;
	}

	.file-chip-remove:hover {
		color: var(--color-text-primary);
	}

	.input-bar {
		min-height: 54px;
		max-height: 50vh;
		overflow: hidden;
		position: relative;
	}

	.input-resize-left {
		position: absolute;
		left: -3px;
		top: 4px;
		bottom: 4px;
		width: 6px;
		cursor: ew-resize;
		z-index: 10;
	}

	.input-resize-right {
		position: absolute;
		right: -3px;
		top: 4px;
		bottom: 4px;
		width: 6px;
		cursor: ew-resize;
		z-index: 10;
	}

	.chat-input {
		flex: 1;
		min-width: 0;
		max-width: 100%;
		background: transparent;
		color: var(--color-text-primary);
		font-size: 1rem;
		line-height: 1.5;
		min-height: 1.5rem;
		max-height: calc(50vh - 2rem);
		resize: none;
		border: none;
		outline: none;
		overflow-y: auto;
		overflow-x: hidden;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.chat-input::placeholder {
		color: var(--color-text-tertiary);
	}

	.copy-btn {
		opacity: 0.5;
		padding: 0.25rem 0.5rem;
		border-radius: 0.25rem;
	}

	.copy-btn:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.1);
	}

	:global([data-theme='light']) .copy-btn:hover {
		background: rgba(0, 0, 0, 0.05);
	}

	.messages-box {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		position: relative;
	}

	.resize-handle {
		position: absolute;
		z-index: 10;
	}

	.resize-top {
		top: -3px;
		left: 16px;
		right: 16px;
		height: 6px;
		cursor: ns-resize;
	}

	.resize-left {
		left: -3px;
		top: 16px;
		bottom: 16px;
		width: 6px;
		cursor: ew-resize;
	}

	.resize-right {
		right: -3px;
		top: 16px;
		bottom: 16px;
		width: 6px;
		cursor: ew-resize;
	}

	.resize-top-left {
		top: -4px;
		left: -4px;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
	}

	.resize-top-right {
		top: -4px;
		right: -4px;
		width: 14px;
		height: 14px;
		cursor: nesw-resize;
	}

	.resize-handle:hover {
		background: rgba(var(--color-accent-rgb, 139, 92, 246), 0.3);
		border-radius: 3px;
	}

	.chat-container.resizing {
		transition: none;
		user-select: none;
	}

	.messages-header {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		flex-shrink: 0;
		height: 40px;
	}

	:global([data-theme='light']) .messages-header {
		border-bottom-color: rgba(0, 0, 0, 0.1);
	}

	.messages-scroll-area {
		height: calc(100% - 40px);
		display: flex;
		flex-direction: column-reverse;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
		padding: 0.75rem 1rem;
	}

	.messages-scroll-area > .messages-wrapper {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.load-history-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all var(--duration-fast) ease;
		margin-bottom: 0.5rem;
	}

	.load-history-btn:hover:not(.loading) {
		color: var(--color-text-primary);
		background: var(--color-elevated);
		border-color: var(--color-accent);
	}

	.load-history-btn.loading {
		cursor: default;
		opacity: 0.7;
	}

	.message-item {
		max-width: 100%;
		overflow: hidden;
	}

	.user-bubble {
		background: rgba(var(--color-accent-rgb), 0.2);
		border: 1px solid rgba(var(--color-accent-rgb), 0.3);
		border-radius: 1rem 1rem 0.25rem 1rem;
		padding: 0.5rem 0.875rem;
		max-width: 85%;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.user-bubble p {
		color: var(--color-text-primary);
		word-break: break-word;
		overflow-wrap: break-word;
	}

	.user-message-text.truncated {
		display: -webkit-box;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
		white-space: pre-wrap;
	}

	.view-all-btn {
		padding: 0;
		font-size: 0.75rem;
		color: var(--color-accent);
		background: none;
		border: none;
		cursor: pointer;
	}

	.view-all-btn:hover {
		text-decoration: underline;
	}

	.source-badge {
		font-size: 0.625rem;
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		background: rgba(var(--color-accent-rgb), 0.15);
		color: var(--color-text-tertiary);
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.025em;
	}

	.streaming-indicator {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-accent);
		animation: pulse-streaming 1s ease-in-out infinite;
	}

	@keyframes pulse-streaming {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.tool-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		background: rgba(var(--color-accent-rgb), 0.15);
		border: 1px solid rgba(var(--color-accent-rgb), 0.3);
		border-radius: 0.375rem;
		font-size: 0.75rem;
		color: var(--color-text-secondary);
	}

	.tool-spinner {
		width: 10px;
		height: 10px;
		border: 1.5px solid rgba(var(--color-accent-rgb), 0.3);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.thinking-indicator {
		display: block;
	}

	.thinking-toggle-inline {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		opacity: 0.7;
	}

	.thinking-toggle-inline:hover {
		opacity: 1;
	}

	.thinking-content-expanded {
		color: var(--color-text-secondary);
		font-family: var(--font-mono);
		font-size: 0.7rem;
		line-height: 1.5;
		white-space: pre-wrap;
		max-height: 150px;
		overflow-y: auto;
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: var(--color-surface);
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
	}

	/* Custom scrollbar */
	.glass-box ::-webkit-scrollbar,
	.messages-scroll-area ::-webkit-scrollbar {
		width: 6px;
	}

	.glass-box ::-webkit-scrollbar-track,
	.messages-scroll-area ::-webkit-scrollbar-track {
		background: transparent;
	}

	.glass-box ::-webkit-scrollbar-thumb,
	.messages-scroll-area ::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.2);
		border-radius: 3px;
	}

	.glass-box ::-webkit-scrollbar-thumb:hover,
	.messages-scroll-area ::-webkit-scrollbar-thumb:hover {
		background: rgba(255, 255, 255, 0.3);
	}

	:global([data-theme='light']) .glass-box ::-webkit-scrollbar-thumb,
	:global([data-theme='light']) .messages-scroll-area ::-webkit-scrollbar-thumb {
		background: rgba(0, 0, 0, 0.2);
	}

	:global([data-theme='light']) .glass-box ::-webkit-scrollbar-thumb:hover,
	:global([data-theme='light']) .messages-scroll-area ::-webkit-scrollbar-thumb:hover {
		background: rgba(0, 0, 0, 0.3);
	}

	/* Chat prose */
	.chat-prose {
		overflow-wrap: break-word;
		word-break: break-word;
		width: 100%;
		max-width: 100%;
		box-sizing: border-box;
	}

	.chat-prose :global(p) {
		margin: 0.5em 0;
		line-height: 1.6;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.chat-prose :global(p:first-child) { margin-top: 0; }
	.chat-prose :global(p:last-child) { margin-bottom: 0; }

	.chat-prose :global(code) {
		background: var(--color-elevated);
		color: var(--color-text-primary);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		font-size: 0.875em;
		font-family: var(--font-mono);
		word-break: break-all;
	}

	.chat-prose :global(pre) {
		background: var(--color-elevated);
		color: var(--color-text-primary);
		padding: 0.75rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 0.5em 0;
		max-width: 100%;
		border: 1px solid var(--color-border);
	}

	.chat-prose :global(pre code) {
		background: none;
		padding: 0;
		font-family: var(--font-mono);
	}

	.chat-prose :global(a) { color: var(--color-accent); }
	.chat-prose :global(strong) { color: var(--color-text-emphasis); }

	.chat-prose :global(h1),
	.chat-prose :global(h2),
	.chat-prose :global(h3),
	.chat-prose :global(h4),
	.chat-prose :global(h5),
	.chat-prose :global(h6) {
		color: var(--color-text-emphasis);
	}

	.chat-prose :global(li) { color: var(--color-text-primary); }
	.chat-prose :global(li::marker) { color: var(--color-text-tertiary); }
	.chat-prose :global(blockquote) { color: var(--color-text-secondary); border-left-color: var(--color-border); }
	.chat-prose :global(hr) { border-color: var(--color-border); }
	.chat-prose :global(th) { color: var(--color-text-emphasis); }
	.chat-prose :global(td) { color: var(--color-text-primary); }

	/* Animations */
	@keyframes slide-up {
		from { opacity: 0; transform: translateY(0.5rem); }
		to { opacity: 1; transform: translateY(0); }
	}

	.animate-slide-up {
		animation: slide-up 0.2s ease-out;
	}

	.dots {
		display: inline-block;
		animation: dots 1.4s infinite;
	}

	@keyframes dots {
		0%, 20% { opacity: 0; }
		40% { opacity: 1; }
		60%, 100% { opacity: 0; }
	}
</style>
