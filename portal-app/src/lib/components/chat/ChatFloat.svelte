<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';
	import JSZip from 'jszip';
	import { chatMessages, connectionStatus, activeModel, noModelMessage, type ChatMessage } from '$lib/stores/chat';
	import { navigationState, spaceScope, docScope } from '$lib/stores/navigation';
	import { apiPostForm, apiGet, api } from '$lib/api';
	// Timeline-style helpers — strip the bracket-prefixed group/reply
	// context that telegram-bot.js prepends for the agent prompt, and
	// pick a brand glyph for the source. Reused so chat ↔ timeline
	// stay consistent.
	import {
		extractReplyContext,
		stripAttachmentPlaceholder,
		parseSource,
		getSourceStyle,
		formatChannelLabel,
		type TimelineAttachment,
	} from '$lib/timeline/utils';
	import { uploadFile as chunkedUpload } from '$lib/chunked-upload';
	import { isSecureChannelConfigured } from '$lib/vps-identity';
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

	// ── Switch AI provider from the chat ──────────────────────────────────────
	// Clicking the active-model chip opens a menu of configured providers; picking
	// one flips is_active on the server (PUT /portal/providers/:id) — which is the
	// per-user active provider every chat with this agent then uses. Optimistic
	// chip update; the next turn's `model` event confirms it.
	let providerMenuOpen = $state(false);
	let chatProviders = $state<any[]>([]);
	let switchingId = $state<number | null>(null);
	const isLocalBase = (u?: string) => !!u && /(?:127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(u);
	async function loadChatProviders() {
		try { const r = await apiGet<{ providers: any[] }>('/portal/providers'); chatProviders = r.providers || []; }
		catch { chatProviders = []; }
	}
	function toggleProviderMenu() {
		providerMenuOpen = !providerMenuOpen;
		if (providerMenuOpen) loadChatProviders();
	}
	async function switchProvider(p: any) {
		if (p.is_active) { providerMenuOpen = false; return; }
		switchingId = p.id;
		try {
			const res = await api(`/portal/providers/${p.id}`, { method: 'PUT', body: JSON.stringify({ is_active: true }) });
			if (res.ok) {
				const local = isLocalBase(p.base_url);
				activeModel.set({ label: p.label || p.provider, model: p.model_preference || '', jurisdiction: local ? 'local' : '', local });
				chatProviders = chatProviders.map((x) => ({ ...x, is_active: x.id === p.id }));
				providerMenuOpen = false;
			}
		} catch { /* leave menu open so the user can retry */ }
		finally { switchingId = null; }
	}

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
	let inputRef = $state<HTMLTextAreaElement>();
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
	type ResizeEdge =
		| 'top' | 'right' | 'bottom' | 'left'
		| 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

	// Bound to the chat container <div>. Used at resize-start to read
	// the exact rendered rect (so the position-anchor math doesn't
	// have to re-derive it from chatWidth + the centered transform,
	// which had off-by-chatHeight bugs and clamp discontinuities).
	let chatContainerRef = $state<HTMLDivElement | null>(null);

	// Dragging state
	let isDragging = $state(false);
	let dragOffset = $state({ x: 0, y: 0 });

	// Position state - null means centered (default)
	let position = $state<{ x: number; y: number } | null>(null);

	function clampToViewport() {
		if (!position) return;
		// Match onDrag: allow overhang on either side as long as a
		// 60px strip stays visible. Re-clamps on window resize so the
		// chat can't end up entirely off-screen after rotation/zoom.
		const cw = Math.min(chatWidth, window.innerWidth - 32);
		const minVisible = 60;
		const minX = -(cw - minVisible);
		const maxX = window.innerWidth - minVisible;
		const minY = 16;
		const maxY = window.innerHeight - 60 - 16;

		const clampedX = Math.max(minX, Math.min(maxX, position.x));
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
					// Same loosened bounds as onDrag/clampToViewport —
					// otherwise a loosely-placed chat reverts to centered
					// on the next reload. clampToViewport will tighten it
					// up if a window resize made it unreachable.
					const cw = Math.min(chatWidth, window.innerWidth - 32);
					const minVisible = 60;
					const minX = -(cw - minVisible);
					const maxX = window.innerWidth - minVisible;
					const maxY = window.innerHeight - 60 - 16;
					if (
						typeof parsed?.x === 'number' && typeof parsed?.y === 'number' &&
						parsed.x >= minX && parsed.x <= maxX && parsed.y >= 16 && parsed.y <= maxY
					) {
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

	// When docScope is set with an agentId hint (the doc was authored
	// by a known agent), auto-switch the chat to that agent so the
	// reply comes from whoever wrote the doc. Skips if it's already
	// the selected agent.
	$effect(() => {
		const ds = $docScope;
		if (!ds || !ds.agentId) return;
		if (selectedAgentId === ds.agentId) return;
		switchAgent(ds.agentId);
	});

	// Resize handlers.
	//
	// Coordinate model:
	//   position.x = chat's left edge x (viewport coords)
	//   position.y = INPUT-BAR top y (viewport coords)
	//   chatHeight = messages-area height (the 60px input bar is
	//                rendered as a separate sibling below the messages)
	//
	// Anchors per edge:
	//   left grip  → keep RIGHT edge fixed
	//   right grip → keep LEFT edge fixed
	//   top grip   → keep BOTTOM (input-bar bottom) fixed
	//   bottom grip→ keep TOP (messages-area top) fixed
	//
	// Why this is fully imperative (no Svelte state during drag):
	//
	// The previous version updated `chatWidth` AND `position.x` on every
	// mousemove. That triggered Svelte to rewrite the container's whole
	// `style="…"` attribute as a string. Even though both new values
	// land in a single attribute mutation, the browser is free to apply
	// `left` and `width` in separate paint/layout passes — and it does,
	// visibly, on left-side corners. The right edge appears to wobble
	// against the cursor because for one frame `left` has shifted but
	// `width` hasn't grown yet (or vice versa). Right-side corners feel
	// fine because `left` never changes there, only `width`.
	//
	// Fix: don't touch Svelte state during the drag. Instead, mutate
	// the DOM directly (`el.style.width`, `.left`, `.bottom` and the
	// messages-box height). Svelte never re-renders during the drag,
	// so the `style="…"` attribute is never rewritten, and the inline
	// properties we set survive frame-to-frame. We only commit the
	// final values to state on mouseup.
	function startResize(edge: ResizeEdge) {
		return (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (!chatContainerRef) return;

			const startX = e.clientX;
			const startY = e.clientY;
			const startWidth = chatWidth;
			const startHeight = chatHeight;

			const isLeftEdge = edge === 'left' || edge === 'top-left' || edge === 'bottom-left';
			const isRightEdge = edge === 'right' || edge === 'top-right' || edge === 'bottom-right';
			const isTopEdge = edge === 'top' || edge === 'top-left' || edge === 'top-right';
			const isBottomEdge = edge === 'bottom' || edge === 'bottom-left' || edge === 'bottom-right';

			// Source of truth for the start state — the rendered rect.
			// Captured BEFORE state mutation so it reflects the user's
			// actual visual starting point (post-translate centered or
			// already-anchored).
			const rect = chatContainerRef.getBoundingClientRect();
			const startLeft   = rect.left;
			const startRight  = rect.right;
			const startBottom = rect.bottom;
			const startInputBarTop = startBottom - 60;
			// Messages-area top — anchor for bottom-edge resize. The
			// chat container has `gap-3` (12px) between messages-box
			// and input-bar, so subtract that on top of the 60px bar.
			const startMessagesTop = startBottom - 60 - 12 - startHeight;

			// Find messages-box once for direct height updates.
			const messagesBox = chatContainerRef.querySelector(
				'.messages-box',
			) as HTMLElement | null;

			// Local accumulators — we drive the DOM from these and
			// commit them to Svelte state on mouseup only.
			let curWidth = startWidth;
			let curHeight = startHeight;
			let curLeft = startLeft;
			let curInputBarTop = startInputBarTop;

			// Materialize position state synchronously if it was null.
			// This causes ONE Svelte render where containerStyle flips
			// from centered (transform: translateX(-50%)) to anchored
			// (left:Xpx). We use the rendered rect so the anchored
			// values land on the exact same pixels — no visible jump.
			// Subsequent mousemoves don't change state, so Svelte
			// won't re-render again until mouseup.
			if (!position) {
				position = { x: startLeft, y: startInputBarTop };
			}
			isResizing = true;

			// Defensive: kill the container's transition synchronously
			// so the .resizing class application timing doesn't matter.
			// (Class wins via cascade once it lands; this just bridges
			// the gap before the next render.)
			chatContainerRef.style.transition = 'none';

			function applyImperative() {
				if (!chatContainerRef) return;
				const cw = Math.min(curWidth, window.innerWidth - 32);
				const bottomOffset = Math.max(
					16,
					window.innerHeight - curInputBarTop - 60,
				);
				chatContainerRef.style.width = cw + 'px';
				chatContainerRef.style.left = curLeft + 'px';
				chatContainerRef.style.bottom = bottomOffset + 'px';
				chatContainerRef.style.transform = 'none';
				if (messagesBox) {
					const mh = Math.min(curHeight, window.innerHeight - 120);
					messagesBox.style.height = mh + 'px';
				}
			}

			function onMouseMove(e: MouseEvent) {
				if (isLeftEdge) {
					curWidth = Math.max(
						320,
						Math.min(1200, startWidth + (startX - e.clientX)),
					);
					curLeft = startRight - curWidth;
				} else if (isRightEdge) {
					curWidth = Math.max(
						320,
						Math.min(1200, startWidth + (e.clientX - startX)),
					);
					curLeft = startLeft;
				}

				const maxHeight = window.innerHeight - 100;
				if (isTopEdge) {
					curHeight = Math.max(
						200,
						Math.min(maxHeight, startHeight + (startY - e.clientY)),
					);
					curInputBarTop = startInputBarTop;
				} else if (isBottomEdge) {
					curHeight = Math.max(
						200,
						Math.min(maxHeight, startHeight + (e.clientY - startY)),
					);
					curInputBarTop = startMessagesTop + 12 + curHeight;
				}

				applyImperative();
			}

			function onMouseUp() {
				window.removeEventListener('mousemove', onMouseMove);
				window.removeEventListener('mouseup', onMouseUp);

				// Commit the final values to Svelte state. The reactive
				// `style={…}` expression will recompute and write the
				// attribute — its values match what we just set
				// imperatively, so there's no visible jump.
				chatWidth = curWidth;
				chatHeight = curHeight;
				position = { x: curLeft, y: curInputBarTop };
				isResizing = false;
				saveChatSize();
				savePosition();

				// Clear our imperative inline overrides so the reactive
				// style attr is the single source of truth again.
				if (chatContainerRef) {
					chatContainerRef.style.width = '';
					chatContainerRef.style.left = '';
					chatContainerRef.style.bottom = '';
					chatContainerRef.style.transform = '';
					chatContainerRef.style.transition = '';
				}
				if (messagesBox) messagesBox.style.height = '';
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

	// Auto-scroll: only reset scroll lock when a NEW message arrives (user sends),
	// not during streaming content updates. This lets the user scroll up to read
	// earlier messages while the AI is still generating.
	let prevMsgCount = 0;
	$effect(() => {
		const msgCount = $chatMessages.length;
		if (msgCount > prevMsgCount && !isLoadingHistory) {
			const newest = $chatMessages[msgCount - 1];
			// Only auto-scroll + unlock for user messages (they just sent something)
			// or the very first assistant message in a stream (it just appeared)
			if (newest?.role === 'user' || (newest?.role === 'assistant' && msgCount === prevMsgCount + 1 && !userHasScrolled)) {
				userHasScrolled = false;
				setTimeout(() => {
					if (messagesContainerRef) messagesContainerRef.scrollTop = 0;
				}, 50);
			}
		}
		prevMsgCount = msgCount;
	});

	// Scroll during streaming — only if user hasn't scrolled up
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
				// 90-500MB ZIPs: strip media client-side; >500MB: upload raw (server extracts)
				if (file.name.endsWith('.zip') && file.size > 90_000_000 && file.size <= 500_000_000) {
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
				const res = await chunkedUpload(file) as { attachmentId: string; type: string; content: string; filename: string; importResult?: { type: string; imported: number; skipped: number; stats?: Record<string, number> } };
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

	// Telegram-style multi-send: pressing Send always reflects the user
	// bubble immediately and queues the message. A single processor
	// drains the queue one POST at a time (each gets its own assistant
	// bubble + abort controller), so the user can keep typing while
	// the agent is still streaming the previous answer.
	let pendingSends = $state<string[]>([]);
	let isProcessingQueue = $state(false);

	async function sendMessage() {
		const text = message.trim();
		if (!text) return;

		isExpanded = true;

		// Always show the user bubble right away, regardless of whether
		// another stream is mid-flight. This is the visible signal that
		// the message was accepted — same as Telegram putting your
		// message in the thread the moment you tap send.
		const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		chatMessages.addMessage({
			id: userMsgId,
			role: 'user',
			content: text,
			timestamp: Date.now()
		});

		message = '';
		if (inputRef) inputRef.style.height = 'auto';

		pendingSends = [...pendingSends, text];
		if (!isProcessingQueue) {
			processSendQueue();
		}
	}

	async function processSendQueue() {
		isProcessingQueue = true;
		while (pendingSends.length > 0) {
			const next = pendingSends[0];
			pendingSends = pendingSends.slice(1);
			await runSend(next);
		}
		isProcessingQueue = false;
	}

	// Single send turn — was the body of sendMessage. Each invocation
	// owns one assistant bubble + one AbortController; cancelStream
	// only aborts the in-flight turn, so the queue keeps draining.
	async function runSend(userMessage: string) {
		const assistantMsgId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

		let content = '';
		let thinking = '';

		try {
			let toolsInProgress: string[] = [];
			let usage: { inputTokens: number; outputTokens: number; cost: number } | undefined;
			let thinkingTokens = 0;

			const handleEvent = (event: Record<string, unknown>) => {
				switch (event.type) {
					case 'stream_start':
						connectionStatus.setStatus('streaming');
						break;
					case 'model':
						// The active provider+model answering this turn — show it as a chip.
						activeModel.set({ label: event.label as string, model: event.model as string, jurisdiction: event.jurisdiction as string, local: event.local as boolean });
						noModelMessage.set(null);
						break;
					case 'no_model':
						// No AI connected — surface a clear, actionable state (no silent hang).
						noModelMessage.set((event.message as string) || 'No AI model is connected.');
						chatMessages.updateMessage(assistantMsgId, { content: (event.message as string) || 'No AI model is connected. Open Settings → Connect AI to add one.', isStreaming: false, toolsInProgress: [] });
						break;
					case 'text_delta':
						content += (event.content as string) || (event.text as string) || '';
						chatMessages.updateMessage(assistantMsgId, { content });
						break;
					case 'thinking_start':
						thinking = '';
						break;
					case 'thinking_delta':
						thinking += (event.content as string) || (event.text as string) || '';
						chatMessages.updateMessage(assistantMsgId, { thinking });
						break;
					case 'thinking_end':
						break;
					case 'tool_start':
						toolsInProgress = [...toolsInProgress, (event.name as string) || (event.tool as string) || 'tool'];
						chatMessages.updateMessage(assistantMsgId, { toolsInProgress });
						break;
					case 'tool_complete':
					case 'tool_error':
						toolsInProgress = toolsInProgress.filter((t) => t !== ((event.name as string) || (event.tool as string)));
						chatMessages.updateMessage(assistantMsgId, { toolsInProgress });
						break;
					case 'usage':
						usage = {
							inputTokens: event.inputTokens as number,
							outputTokens: event.outputTokens as number,
							cost: ((event.inputTokens as number) / 1_000_000) * 3 + ((event.outputTokens as number) / 1_000_000) * 15
						};
						thinkingTokens = (event.thinkingTokens as number) || 0;
						break;
					case 'done':
						chatMessages.updateMessage(assistantMsgId, {
							isStreaming: false,
							toolsInProgress: [],
							toolsUsed: (event.toolsUsed as string[]) || [],
							tokenUsage: usage,
							thinkingTokens: thinkingTokens > 0 ? thinkingTokens : undefined
						});
						break;
					case 'error':
						if (content) {
							content += `\n\n*Error: ${event.message}*`;
							chatMessages.updateMessage(assistantMsgId, { content });
						} else {
							throw new Error(event.message as string);
						}
						break;
					case 'keepalive':
						break;
				}
			};

			// Route through encrypted WS channel if configured
			if (isSecureChannelConfigured()) {
				const { getChannel } = await import('$lib/secure-channel');
				const channel = getChannel();
				connectionStatus.setStatus('streaming');
				await channel.requestStream('chat', {
					message: userMessage,
					enableThinking,
					...(selectedAgentId ? { agentId: selectedAgentId } : {}),
				}, (chunk) => {
					handleEvent(chunk as Record<string, unknown>);
				});
				// Stream complete
				if (!usage) {
					chatMessages.updateMessage(assistantMsgId, {
						isStreaming: false,
						toolsInProgress: []
					});
				}
			} else {
				// Fallback: plain HTTPS (no encrypted channel configured)
				const csrfMatch = document.cookie.match(/mycelium_csrf=([^;]+)/);
				const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
				if (csrfMatch) chatHeaders['X-CSRF-Token'] = csrfMatch[1];

				// When the chat is scoped to a Shared Space, forward the
				// spaceId so /portal/chat/stream loads that space's context
				// (system prompt + recent space_conversations messages).
				const scopedSpace = $spaceScope;
				// When the chat is scoped to a library doc, append a
				// reference line to the message so the agent knows which
				// screen the user is viewing — and pass docPath/docTitle
				// in the body so the backend can later inject the doc's
				// content into context if it wants.
				const scopedDoc = $docScope;
				const messageWithContext = scopedDoc
					? `${userMessage}\n\n[Re: viewing document "${scopedDoc.title}" at ${scopedDoc.path}]`
					: userMessage;
				// Self-hosted V1 serves portal routes under /api/v1/portal (the api()
				// helper rewrites /portal/* there; this raw fetch must do it too, or it
				// 404s — bare /portal/* is unrouted on the REST server).
				const res = await fetch('/api/v1/portal/chat/stream', {
					method: 'POST',
					headers: chatHeaders,
					credentials: 'same-origin',
					body: JSON.stringify({
						message: messageWithContext,
						enableThinking,
						...(selectedAgentId ? { agentId: selectedAgentId } : {}),
						...(scopedSpace ? { spaceId: scopedSpace.id } : {}),
						...(scopedDoc ? { docPath: scopedDoc.path, docTitle: scopedDoc.title } : {}),
					}),
					signal: abortController.signal
				});

				if (!res.ok) {
					const text = await res.text();
					let errorMsg = `Server error (${res.status})`;
					try {
						const errData = JSON.parse(text);
						errorMsg = errData.error || errData.message || errorMsg;
					} catch {
						if (text.includes('Agent not configured')) errorMsg = 'Agent not configured';
						else if (res.status === 502) errorMsg = 'Could not reach agent server';
					}
					throw new Error(errorMsg);
				}

				connectionStatus.setStatus('streaming');
				const reader = res.body?.getReader();
				if (!reader) throw new Error('No response body');

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
						const d = line.slice(6);
						if (d === '[DONE]') continue;
						try { handleEvent(JSON.parse(d)); }
						catch (e) { if (!(e instanceof SyntaxError)) throw e; }
					}
				}
				chatMessages.updateMessage(assistantMsgId, { isStreaming: false, toolsInProgress: [] });
			}

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
		// Drop any queued sends — the user is starting fresh.
		pendingSends = [];
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
		return DOMPurify.sanitize(marked(content, { gfm: true, breaks: true }) as string);
	}

	// Bot-prompt artifacts we strip from the displayed body. These
	// patterns are emitted by telegram-bot.js's attachment pipeline
	// (and similar paths) for the AGENT's prompt — they don't belong
	// in the user-visible chat thread. The Telegram CDN URL embeds the
	// bot token, so stripping it client-side is also a defence-in-depth
	// security measure (the canonical fix is for the bot to never
	// store the token in message content).
	//
	//   [Image: photo_xxx.jpg — saved to /home/.../inbox/photo_xxx.jpg]
	//   [File: report.pdf — saved to /…]
	//   (download: https://api.telegram.org/file/bot<TOKEN>/photos/file_503.jpg)
	//   Use the Read tool to view this image directly.
	//   AI description: <multi-line block, ends at blank line or "Caption:">
	function stripBotArtifacts(content: string): string {
		if (!content) return content;
		let body = content;
		// 1. Image / File / Document bracket header. Greedy bracket so
		//    `— saved to …` paths with internal hyphens still close.
		body = body.replace(/\[(?:Image|File|Document|Photo):\s*[^\]]+\]\s*/gi, '');
		// 2. (download: <url>) — strip whether or not it has a token.
		body = body.replace(/\(download:\s*https?:\/\/[^)]*\)\s*/gi, '');
		// 3. Read-tool instruction line.
		body = body.replace(/Use the Read tool to view this image directly\.?\s*\n*/gi, '');
		// 4. AI description block — runs from "AI description:" up to
		//    the next blank line, "Caption:", or end-of-string.
		body = body.replace(
			/AI description:\s*(?:[^\n]*\n(?!\s*\n|Caption:))*[^\n]*\n?\s*\n?/gi,
			'',
		);
		return body.trimStart();
	}

	// Strip the bracket-prefixed `[Group: "…" | From: …]` and
	// `[Replying to X's message: "…"]` blocks the bots prepend for the
	// agent's prompt, plus attachment placeholders the agent saw. The
	// pulled-out context is rendered as a small pill above the body so
	// the agent's thread stays readable.
	function chatMessageView(msg: ChatMessage) {
		const ctx = extractReplyContext(msg.content);
		const tlAttachment = msg.attachment
			? ({
				id: msg.attachment.id,
				type: msg.attachment.type,
				url: msg.attachment.url,
				filename: msg.attachment.filename ?? null,
				fileSize: msg.attachment.fileSize ?? null,
				transcript: msg.attachment.transcript ?? null,
				description: msg.attachment.description ?? null,
			} satisfies TimelineAttachment)
			: null;
		let body = stripAttachmentPlaceholder(ctx.body, tlAttachment);
		body = stripBotArtifacts(body);
		// Only surface the group context when the message's source is
		// actually a group platform. Otherwise the bot's `[Group: …]`
		// prefix on a DM (rare, but it happens) silently mis-labels the
		// thread — we'd rather drop the metadata than mis-attribute.
		const { platform } = parseSource(msg.source);
		const isGroupPlatform = platform === 'telegram-group' || platform === 'discord';
		return {
			body,
			groupTitle: isGroupPlatform ? ctx.groupTitle : null,
			groupAuthor: isGroupPlatform ? ctx.groupAuthor : null,
			replyToName: ctx.replyToName,
			quote: ctx.quote,
		};
	}

	// Source chip — brand glyph + channel name, replacing the old
	// `telegram-group` text. Returns null when there's nothing useful
	// to show (DM-style telegram, portal-internal chat, etc).
	function chatSourceChip(msg: ChatMessage, groupTitle: string | null) {
		if (!msg.source) return null;
		const { platform } = parseSource(msg.source);
		// Web/portal/import sources stay as their old text label so the
		// import provenance ("Claude", "ChatGPT") still surfaces.
		if (platform === 'unknown' || msg.source === 'web' || msg.source.startsWith('import_')) {
			const label = formatSource(msg.source);
			return label ? { kind: 'text' as const, label } : null;
		}
		// Portal/DM telegram → no chip; the chat already implies it.
		if (platform === 'portal') return null;
		const style = getSourceStyle(platform);
		// Conservative channel labelling: only group platforms display
		// a channel name. A telegram DM whose body happened to contain
		// `[Group: "X"]` (bot quirk, mis-tag, agent-mentioned context)
		// no longer mis-attributes the message to that group.
		const isGroupPlatform = platform === 'telegram-group' || platform === 'discord';
		const channel = isGroupPlatform ? formatChannelLabel(msg.source, groupTitle) : '';
		return { kind: 'brand' as const, style, channel };
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

	// Auto-resize textarea — auto-grow caps at 4 lines, then scrolls.
	// Without a cap a long paste pushes the input bar to half the
	// viewport unprompted, crowding out the messages above.
	//
	// Manual override: the textarea has CSS `resize: vertical` (capped
	// at 50vh), so the user can drag the native grip in its bottom-
	// right corner to grow the compose surface for long messages. Once
	// they drag past the 4-line auto cap we leave their height alone
	// — typing won't shrink it back down.
	function handleInput() {
		if (!inputRef) return;
		const computed = window.getComputedStyle(inputRef);
		const lineHeight = parseFloat(computed.lineHeight) || 24;
		const autoCap = lineHeight * 4;

		// Was the user already past the auto cap (i.e. they manually
		// dragged it bigger)? If so, don't recompute — respect their
		// chosen size while they keep typing.
		if (inputRef.offsetHeight > autoCap + 4) return;

		inputRef.style.height = 'auto';
		const newHeight = Math.min(inputRef.scrollHeight, autoCap);
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
		// Only own the window-level file drop while the chat is actually OPEN. In V1
		// the chat is deferred (never open), so the global vault-import drop zone
		// (ImportDropZone, mounted in the app layout) handles drops instead — without
		// this guard BOTH would fire on a single drop (double upload + two overlays).
		// Reading `visible` re-runs this effect to attach/detach as chat opens/closes.
		if (!visible) return;

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

	// Drag handlers.
	//
	// dragOffset is "cursor's offset from the input-bar top-left corner
	// at mousedown time". The drag tracks position.y = input-bar top so
	// the bar follows the cursor with the same offset. We anchor to the
	// input-bar's left/top regardless of where the user actually clicked
	// (input-bar hand icon, header bar, etc.) — the math stays uniform.
	function startDrag(e: MouseEvent) {
		e.preventDefault();
		if (!chatContainerRef) return;
		isDragging = true;
		const rect = chatContainerRef.getBoundingClientRect();
		const inputBarTop = rect.bottom - 60;
		dragOffset = { x: e.clientX - rect.left, y: e.clientY - inputBarTop };
		window.addEventListener('mousemove', onDrag);
		window.addEventListener('mouseup', stopDrag);
	}

	// Header drag: make the top of the chat work like a browser-tab
	// drag-handle. We skip if the mousedown landed on an interactive
	// child (agent dropdown, scope chip ×, status icon, close, …) so
	// those still respond to clicks. Everything else in the header
	// area starts a drag.
	function startHeaderDrag(e: MouseEvent) {
		const target = e.target as HTMLElement | null;
		if (target?.closest('button, a, [role="button"], [role="menu"]')) return;
		startDrag(e);
	}

	function onDrag(e: MouseEvent) {
		if (!isDragging) return;
		const newX = e.clientX - dragOffset.x;
		const inputBarY = e.clientY - dragOffset.y;
		// Use the actual chat width (clamped to viewport) — the
		// previous hardcoded 720 was the invisible right-side wall:
		// a chat resized smaller couldn't reach the right edge, and
		// a chat resized wider got an off-by-X anchor.
		const cw = Math.min(chatWidth, window.innerWidth - 32);
		// Allow the chat to overhang either edge as long as a 60px
		// strip stays visible (so it can always be grabbed back).
		const minVisible = 60;
		const minX = -(cw - minVisible);
		const maxX = window.innerWidth - minVisible;
		// Vertical: input bar must stay touchable. Top down to 16,
		// bottom edge of the chat down to within 16 of viewport bottom.
		const minY = 16;
		const maxY = window.innerHeight - 60 - 16;
		position = {
			x: Math.max(minX, Math.min(maxX, newX)),
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
		const cw = Math.min(chatWidth, window.innerWidth - 32);
		const minVisible = 60;
		const minX = -(cw - minVisible);
		const maxX = window.innerWidth - minVisible;
		position = {
			x: Math.max(minX, Math.min(maxX, newX)),
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

	let isMobile = $state(browser ? window.innerWidth < 768 : false);
	$effect(() => {
		if (!browser) return;
		const mq = window.matchMedia('(max-width: 767px)');
		isMobile = mq.matches;
		const handler = (e: MediaQueryListEvent) => { isMobile = e.matches; };
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});

	// Auto-expand and load history when chat opens (mobile: always; desktop: if no messages yet)
	$effect(() => {
		if (visible && !isExpanded) {
			const shouldAutoExpand = isMobile || $chatMessages.length === 0;
			if (shouldAutoExpand) {
				isExpanded = true;
				if ($chatMessages.length === 0 && !isLoadingHistory) {
					isLoadingHistory = true;
					chatMessages.loadHistory(true, selectedAgentId || undefined)
						.catch(() => {})
						.finally(() => { isLoadingHistory = false; });
				}
			}
		}
	});

	const containerStyle = $derived(() => {
		if (isMobile) return '';
		if (position) {
			const bottomOffset = window.innerHeight - position.y - 60;
			return `left: ${position.x}px; bottom: ${Math.max(16, bottomOffset)}px; transform: none;`;
		}
		return `left: 50%; bottom: 24px; transform: translateX(-50%);`;
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
		<button
			type="button"
			aria-label={attachment.description ? `Open image: ${attachment.description}` : 'Open image in new tab'}
			onclick={() => window.open(attachment.url, '_blank')}
			class="block p-0 border-0 bg-transparent cursor-pointer"
		>
			<img
				src={attachment.url}
				alt={attachment.description || 'Image'}
				class="max-w-[240px] max-h-[200px] rounded-lg object-cover"
			/>
		</button>
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

	<!-- Pointer shield: while dragging/resizing the chat, a transparent
		 fullscreen layer sits just below the chat (z-index 9998) so iframe
		 children of the page (e.g. the library HTML preview) can't capture
		 the mouse and break our window-level mousemove/mouseup. -->
	{#if !isMobile && (isDragging || isResizing)}
		<div class="chat-pointer-shield"></div>
	{/if}

	<!-- Chat container - full screen on mobile, draggable on desktop -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={chatContainerRef}
		class="chat-container fixed flex flex-col transition-all duration-150"
		class:dragging={isDragging}
		class:resizing={isResizing}
		class:chat-mobile={isMobile}
		class:gap-3={!isMobile}
		style={isMobile
			? 'z-index: 9999; inset: 0;'
			: `z-index: 9999; width: min(${chatWidth}px, calc(100vw - 32px)); ${containerStyle()}`}
		onmouseenter={() => { if (!isResizing && !isDragging) isHovered = true; }}
		onmouseleave={() => { if (!isResizing && !isDragging) isHovered = false; }}
	>
		<!-- Messages box -->
		{#if isExpanded}
			<div
				class="messages-box w-full flex flex-col"
				class:glass-box={!isMobile}
				class:rounded-2xl={!isMobile}
				class:shadow-2xl={!isMobile}
				style={isMobile ? 'flex: 1; min-height: 0; background: var(--color-bg);' : `height: min(${chatHeight}px, calc(100vh - 120px));`}
			>
				<!-- Resize handles (desktop only) -->
				{#if !isMobile}
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
				{/if}

				<!-- Header — also a drag handle (browser-tab style). Empty
				     space and decorative chips start a drag; buttons and
				     menus inside still respond to clicks via startHeaderDrag's
				     interactive-child guard. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="messages-header shrink-0"
					class:messages-header-mobile={isMobile}
					class:messages-header-draggable={!isMobile}
					onmousedown={!isMobile ? startHeaderDrag : undefined}
				>
					<!-- Mobile back button -->
					{#if isMobile}
						<button
							onclick={() => { navigationState.setChatOpen(false); isExpanded = false; }}
							class="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-[var(--color-text-secondary)]"
							aria-label="Close chat"
						>
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 19l-7-7 7-7" />
							</svg>
						</button>
					{/if}

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

					<!-- Active model chip → click to switch provider (saved for all chats). -->
					{#if $activeModel}
						<div class="relative">
							<button
								class="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] hover:bg-[var(--color-elevated)] cursor-pointer transition-colors"
								onclick={toggleProviderMenu}
								title="Switch AI model — saved for all chats with this agent"
								aria-haspopup="menu"
								aria-expanded={providerMenuOpen}
							>
								<div class="w-1.5 h-1.5 rounded-full {$activeModel.local ? 'bg-emerald-500' : 'bg-[var(--color-accent)]'}"></div>
								<span class="text-[var(--color-text-secondary)] font-medium">{$activeModel.label}</span>
								<span class="hidden sm:inline text-[var(--color-text-tertiary)]">{$activeModel.model}</span>
								<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-[var(--color-text-tertiary)]"><path d="M6 9l6 6 6-6" /></svg>
							</button>
							{#if providerMenuOpen}
								<div class="absolute right-0 top-full mt-1 z-50 min-w-[230px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg" style="backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);">
									<div class="px-2.5 py-1.5 text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Switch model · saved for all chats</div>
									{#each chatProviders as p (p.id)}
										<button
											class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-[11px] hover:bg-[var(--color-elevated)] {p.is_active ? 'bg-[var(--color-elevated)]' : ''}"
											onclick={() => switchProvider(p)}
											disabled={switchingId === p.id}
										>
											<div class="w-1.5 h-1.5 rounded-full flex-shrink-0 {isLocalBase(p.base_url) ? 'bg-emerald-500' : 'bg-[var(--color-accent)]'}"></div>
											<span class="text-[var(--color-text-primary)] font-medium truncate">{p.label || p.provider}</span>
											<span class="hidden sm:inline text-[var(--color-text-tertiary)] truncate">{p.model_preference || ''}</span>
											<span class="ml-auto flex-shrink-0 text-[9px] text-[var(--color-accent)]">{p.is_active ? '✓' : (switchingId === p.id ? '…' : '')}</span>
										</button>
									{:else}
										<div class="px-2.5 py-2 text-[10px] text-[var(--color-text-tertiary)]">No models yet — add one in Settings → Intelligence.</div>
									{/each}
									<a class="block px-2.5 py-1.5 mt-0.5 text-[10px] text-[var(--color-accent)] hover:underline" href="/settings?tab=intelligence">Manage in Settings →</a>
								</div>
							{/if}
						</div>
					{/if}

					<!-- Space scope chip: shown when chat is scoped to a Shared Space.
					     Closing the × returns chat to global scope. Navigating between
					     spaces auto-switches the chip's content. -->
					{#if $spaceScope}
						<div class="space-scope-chip flex items-center gap-1.5" title="Chat is scoped to this space">
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="3"/>
								<circle cx="12" cy="12" r="9"/>
							</svg>
							<span class="text-[11px] font-medium truncate max-w-[140px]">{$spaceScope.name}</span>
							<button
								onclick={() => navigationState.clearSpaceScope()}
								class="hover:bg-white/10 rounded p-0.5"
								aria-label="Un-scope chat"
								title="Un-scope — return to global chat"
							>
								<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
								</svg>
							</button>
						</div>
					{/if}

					<!-- Doc-scope chip: shown when chat is scoped to a specific
					     library document via the preview's "Chat about this"
					     marker. Closing returns chat to its previous scope. -->
					{#if $docScope}
						<div class="space-scope-chip flex items-center gap-1.5" title="Chat is scoped to {$docScope.path}">
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
								<polyline points="14 2 14 8 20 8"/>
							</svg>
							<span class="text-[11px] font-medium truncate max-w-[140px]">{$docScope.title}</span>
							<button
								onclick={() => navigationState.clearDocScope()}
								class="hover:bg-white/10 rounded p-0.5"
								aria-label="Un-scope chat"
								title="Un-scope — chat without doc context"
							>
								<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
									<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
								</svg>
							</button>
						</div>
					{/if}

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
						onclick={() => { navigationState.setChatOpen(false); isExpanded = false; }}
						class="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
						aria-label="Close chat"
						title="Close chat"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				<!-- Messages area -->
				<div bind:this={messagesContainerRef} class="messages-scroll-area" onscroll={handleMessagesScroll}>
					<div class="messages-wrapper">
					{#if isLoadingHistory}
						<div class="load-history-btn loading">
							<div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
							Loading history...
						</div>
					{:else if $noModelMessage && $chatMessages.length === 0}
						<!-- No AI connected: a clear, actionable state (replaces the silent hang). -->
						<div class="flex flex-col items-center justify-center text-center gap-2 py-10 px-6">
							<div class="text-sm font-medium text-[var(--color-text-primary)]">Connect an AI to start chatting</div>
							<div class="text-xs text-[var(--color-text-tertiary)] max-w-xs">{$noModelMessage}</div>
							<a href="/settings" class="mt-1 text-xs px-3 py-1.5 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 transition-colors">Open Settings → Connect AI</a>
						</div>
					{:else if $chatMessages.length === 0}
						<!-- Genuine empty state: a welcome, not a dead "load history" button (#27). -->
						<div class="flex flex-col items-center justify-center text-center gap-1.5 py-10 px-6">
							<div class="text-sm font-medium text-[var(--color-text-primary)]">Ask your vault anything</div>
							<div class="text-xs text-[var(--color-text-tertiary)] max-w-xs">Your conversations, notes, and memory — searchable and reasoned over. Type a question below to begin.</div>
						</div>
					{/if}

					{#each $chatMessages as msg (msg.id)}
						{@const view = chatMessageView(msg)}
						{@const chip = chatSourceChip(msg, view.groupTitle)}
						<div class="message-item animate-slide-up" class:user={msg.role === 'user'}>
							{#if msg.role === 'user'}
								{@const isMsgExpanded = expandedMessages.has(msg.id)}
								{@const shouldTruncate = needsTruncation(view.body)}
								<div class="flex flex-col items-end gap-1.5 max-w-[85%] ml-auto">
									{#if view.groupTitle || view.replyToName}
										<div class="chat-context-pill">
											{#if view.groupTitle}
												<span class="font-medium">{view.groupTitle}</span>
												{#if view.groupAuthor}
													<span class="text-[var(--color-text-tertiary)]"> · {view.groupAuthor}</span>
												{/if}
											{/if}
											{#if view.replyToName}
												{#if view.groupTitle}<span class="text-[var(--color-text-tertiary)]"> · </span>{/if}
												<span>↪ {view.replyToName}</span>
												{#if view.quote}
													<span class="text-[var(--color-text-tertiary)] italic"> "{view.quote}"</span>
												{/if}
											{/if}
										</div>
									{/if}
									<div class="flex justify-end items-start gap-2 max-w-full">
										{#if msg.attachment}
											<div class="shrink-0">
												{@render attachmentBlock(msg.attachment)}
											</div>
										{/if}
										<div class="user-bubble">
											{#if view.body}
												<div
													class="chat-prose user-message-text text-sm text-[var(--color-text-primary)] max-w-full"
													class:truncated={shouldTruncate && !isMsgExpanded}
												>
													{@html renderMarkdown(view.body)}
												</div>
											{/if}
											<div class="flex items-center justify-end gap-2 mt-1">
												{#if shouldTruncate}
													<button
														onclick={() => toggleMessageExpanded(msg.id)}
														class="view-all-btn"
													>
														{isMsgExpanded ? 'Show less' : 'View all'}
													</button>
												{/if}
												{#if chip}
													{#if chip.kind === 'brand'}
														<span class="source-chip" style="background:{chip.style.bg};color:{chip.style.text};" title={chip.style.title}>
															<svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
																<path d={chip.style.iconPath}/>
															</svg>
															{#if chip.channel}<span class="truncate max-w-[120px]">{chip.channel}</span>{/if}
														</span>
													{:else}
														<span class="source-badge">{chip.label}</span>
													{/if}
												{/if}
											</div>
										</div>
									</div>
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
											{#if chip}
												{#if chip.kind === 'brand'}
													<span class="source-chip" style="background:{chip.style.bg};color:{chip.style.text};" title={chip.style.title}>
														<svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
															<path d={chip.style.iconPath}/>
														</svg>
														{#if chip.channel}<span class="truncate max-w-[120px]">{chip.channel}</span>{/if}
													</span>
												{:else}
													<span class="source-badge">{chip.label}</span>
												{/if}
											{/if}
											{#if msg.isStreaming}
												<span class="streaming-indicator"></span>
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
											{@html renderMarkdown(view.body || msg.content)}
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
		<div
			class="input-bar flex items-center gap-3 px-4 py-3 min-w-0 shrink-0"
			class:glass-box={!isMobile}
			class:shadow-xl={!isMobile}
			class:rounded-xl={!isMobile}
			class:input-bar-mobile={isMobile}
		>
			{#if !isMobile}
			<!-- Horizontal resize handles on input bar (desktop only) -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-left" onmousedown={startResize('left')}></div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-right" onmousedown={startResize('right')}></div>
			<!-- Bottom edge + corners — let the user drag the bottom of
				 the chat down to grow it (top stays fixed), like an OS
				 window. Lives on the input bar because it's the
				 visually-bottom element of the chat. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-bottom" onmousedown={startResize('bottom')}></div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-bottom-left" onmousedown={startResize('bottom-left')}></div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="resize-handle input-resize-bottom-right" onmousedown={startResize('bottom-right')}></div>

			<!-- Drag handle (desktop only) -->
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
			{/if}

			<!-- History/expand button (desktop only) -->
			{#if !isMobile}
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
			{/if}

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
				placeholder={isLoading ? "type your next message..." : "ask me anything..."}
				rows="1"
				class="chat-input"
			></textarea>
			<button
				onclick={sendMessage}
				disabled={!message.trim()}
				class="p-2 rounded-full bg-azure/20 text-azure hover:bg-azure/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 relative"
				aria-label="Send message"
			>
				<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
				</svg>
				<!-- Pending-queue badge: shows the count of messages
					 waiting their turn. Hidden when nothing's queued. -->
				{#if pendingSends.length > 0}
					<span
						class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-aurum text-[var(--color-bg)] text-[10px] font-mono font-medium flex items-center justify-center"
						title="{pendingSends.length} message{pendingSends.length === 1 ? '' : 's'} queued"
					>
						{pendingSends.length}
					</span>
				{/if}
			</button>
		</div>
	</div>
{/if}

<style>
	/* Solid panel. The Tauri webview (WKWebView) does not composite backdrop-filter
	   blur over app content, so a translucent "glass" background just reads as
	   see-through ("passthrough"). We use a fully OPAQUE, theme-matched surface so
	   the chat is a clean solid panel, with a border + shadow to lift it off the
	   page. (No backdrop-filter — it does nothing useful here and an opaque bg has
	   nothing to blur through anyway.) */
	.glass-box {
		background: #16161b;
		border: 1px solid rgba(255, 255, 255, 0.10);
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
	}

	:global([data-theme='light']) .glass-box {
		background: #ffffff;
		border-color: rgba(0, 0, 0, 0.08);
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.16);
	}

	/* Mobile full-screen mode */
	.chat-container.chat-mobile {
		display: flex;
		flex-direction: column;
		background: var(--color-bg);
		width: 100% !important;
	}

	.messages-header-mobile {
		height: 48px;
		padding: 0.5rem 0.75rem;
		background: var(--color-surface);
		border-bottom: 1px solid var(--color-border);
	}

	.input-bar-mobile {
		background: var(--color-surface);
		border-top: 1px solid var(--color-border);
		padding-bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
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

	.input-resize-bottom {
		position: absolute;
		bottom: -3px;
		left: 16px;
		right: 16px;
		height: 6px;
		cursor: ns-resize;
		z-index: 10;
	}

	.input-resize-bottom-left {
		position: absolute;
		bottom: -4px;
		left: -4px;
		width: 14px;
		height: 14px;
		cursor: nesw-resize;
		z-index: 11;
	}

	.input-resize-bottom-right {
		position: absolute;
		bottom: -4px;
		right: -4px;
		width: 14px;
		height: 14px;
		cursor: nwse-resize;
		z-index: 11;
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
		/* Auto-grow caps at 4 lines (handleInput); manual drag of the
		   native grip can grow the compose surface up to 50vh. */
		max-height: 50vh;
		resize: vertical;
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

	/* Transparent fullscreen layer that sits just below the chat
	   (z-index 9998 vs chat's 9999) while dragging/resizing. It
	   intercepts mouse events from any iframe in the page so that
	   window-level mousemove/mouseup keep firing — without it,
	   moving the cursor over an iframe ends drag tracking
	   prematurely. */
	.chat-pointer-shield {
		position: fixed;
		inset: 0;
		z-index: 9998;
		background: transparent;
		cursor: inherit;
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

	/* Browser-tab style: the bar itself is grabbable. Children that
	   are interactive (buttons, dropdowns) restore their own cursor. */
	.messages-header-draggable {
		cursor: grab;
		user-select: none;
	}
	.messages-header-draggable:active {
		cursor: grabbing;
	}
	.messages-header-draggable :where(button, a) {
		cursor: pointer;
	}

	:global([data-theme='light']) .messages-header {
		border-bottom-color: rgba(0, 0, 0, 0.1);
	}

	.space-scope-chip {
		padding: 2px 8px;
		border-radius: 999px;
		background: rgba(167, 139, 250, 0.12);
		color: var(--color-accent-amethyst, #A78BFA);
		border: 1px solid rgba(167, 139, 250, 0.28);
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
		max-width: 100%;
		overflow-wrap: break-word;
		word-break: break-word;
	}

	.user-message-text.truncated {
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
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

	/* Brand-glyph chip for telegram/discord/whatsapp messages.
	   Sits where the old `source-badge` did; bg/color come from
	   getSourceStyle() so the platform reads instantly. */
	.source-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.625rem;
		padding: 0.125rem 0.4rem;
		border-radius: 9999px;
		font-weight: 500;
		max-width: 200px;
	}

	/* Context pill above a user message in a group chat — surfaces
	   the group title / reply target the bots stripped from the
	   prompt. Subtle so it doesn't compete with the actual content. */
	.chat-context-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.125rem 0.5rem;
		border-radius: 9999px;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.08);
		color: var(--color-text-secondary);
		font-size: 0.6875rem;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	:global([data-theme='light']) .chat-context-pill {
		background: rgba(0, 0, 0, 0.04);
		border-color: rgba(0, 0, 0, 0.08);
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
