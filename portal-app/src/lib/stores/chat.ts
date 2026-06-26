import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import { api } from '$lib/api';

export interface Attachment {
	id: string;
	type: 'image' | 'voice' | 'video' | 'file';
	url: string;
	filename?: string;
	fileSize?: number;
	transcript?: string;
	description?: string;
}

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: number;
	isStreaming?: boolean;
	toolsInProgress?: string[];
	toolsUsed?: string[];
	thinking?: string;
	tokenUsage?: { inputTokens: number; outputTokens: number; cost: number };
	thinkingTokens?: number;
	source?: string;
	attachment?: Attachment;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'streaming' | 'error';

// Per-thread conversation key (Phase 5 chat threading): one UUID per chat thread,
// persisted so a reload continues the SAME thread; a fresh id starts a new thread
// (on "Clear"). Sent on every /chat/stream + /chat/history call so the backend can
// scope conversation memory to this thread.
const CONVERSATION_KEY = 'mycelium-chat-conversation';
function genConversationId(): string {
	try { return crypto.randomUUID(); }
	catch { return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
}

// How many orphaned chat turns (saved before the conversationId send-path fix,
// with conversation_id = NULL) could be recovered into the current thread. Drives
// the one-click "Recover N earlier messages" affordance; 0 hides it.
export const recoverableCount = writable<number>(0);

function createChatStore() {
	const { subscribe, set, update } = writable<ChatMessage[]>([]);
	let hasLoaded = false;
	let conversationId: string = browser ? (localStorage.getItem(CONVERSATION_KEY) || '') : '';

	const ensureConversationId = (): string => {
		if (!conversationId) {
			conversationId = genConversationId();
			if (browser) localStorage.setItem(CONVERSATION_KEY, conversationId);
		}
		return conversationId;
	};

	return {
		subscribe,
		addMessage: (msg: ChatMessage) => update((msgs) => [...msgs, msg]),
		updateMessage: (id: string, updates: Partial<ChatMessage>) =>
			update((msgs) => msgs.map((m) => (m.id === id ? { ...m, ...updates } : m))),
		clear: () => { set([]); hasLoaded = false; },
		set,

		// The current thread key (generating + persisting one on first use).
		getConversationId: (): string => ensureConversationId(),
		// Start a fresh thread: new id + drop the loaded flag so the next open is empty.
		newConversation: (): string => {
			conversationId = genConversationId();
			if (browser) localStorage.setItem(CONVERSATION_KEY, conversationId);
			hasLoaded = false;
			return conversationId;
		},

		loadHistory: async (force = false, agentId?: string): Promise<ChatMessage[]> => {
			if (!browser || (hasLoaded && !force)) return [];
			try {
				const params = new URLSearchParams({ limit: '50', conversationId: ensureConversationId() });
				if (agentId) params.set('agentId', agentId);
				const response = await api(`/portal/chat/history?${params}`);
				if (!response.ok) return [];
				const data = await response.json();
				const messages = data.messages || [];
				// Offer recovery only when THIS thread is empty (backend reports a
				// count there); once it has turns we never nag.
				recoverableCount.set(messages.length > 0 ? 0 : Number(data.recoverable) || 0);
				if (messages.length > 0) {
					set(messages);
					hasLoaded = true;
				}
				return messages;
			} catch {
				return [];
			}
		},

		// Explicitly pull orphaned earlier chats (NULL conversation_id) into THIS
		// thread, then show them. One-shot: after it runs the pool is drained.
		recoverHistory: async (): Promise<number> => {
			if (!browser) return 0;
			try {
				const response = await api('/portal/chat/history/recover', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ conversationId: ensureConversationId(), limit: 50 }),
				});
				if (!response.ok) return 0;
				const data = await response.json();
				const messages = data.messages || [];
				if (messages.length > 0) { set(messages); hasLoaded = true; }
				recoverableCount.set(0);
				return Number(data.recovered) || 0;
			} catch {
				return 0;
			}
		},

		get hasLoaded() { return hasLoaded; },
	};
}

function createConnectionStore() {
	const { subscribe, set } = writable<ConnectionStatus>('idle');
	return {
		subscribe,
		setStatus: (status: ConnectionStatus) => set(status),
		reset: () => set('idle'),
	};
}

export const chatMessages = createChatStore();
export const connectionStatus = createConnectionStore();

// The provider+model actually answering this conversation (from the backend's
// `model` SSE event) — shown as a chip so the active intelligence is always visible.
export interface ActiveModel { label: string; model: string; jurisdiction?: string; local?: boolean; }
export const activeModel = writable<ActiveModel | null>(null);

// Non-null = no AI model is connected; the value is the actionable message from the
// backend's `no_model` event. Chat shows a "Connect a model" state instead of a
// silent failure / 90s hang.
export const noModelMessage = writable<string | null>(null);
