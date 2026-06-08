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

function createChatStore() {
	const { subscribe, set, update } = writable<ChatMessage[]>([]);
	let hasLoaded = false;

	return {
		subscribe,
		addMessage: (msg: ChatMessage) => update((msgs) => [...msgs, msg]),
		updateMessage: (id: string, updates: Partial<ChatMessage>) =>
			update((msgs) => msgs.map((m) => (m.id === id ? { ...m, ...updates } : m))),
		clear: () => { set([]); hasLoaded = false; },
		set,

		loadHistory: async (force = false, agentId?: string): Promise<ChatMessage[]> => {
			if (!browser || (hasLoaded && !force)) return [];
			try {
				const params = new URLSearchParams({ limit: '50' });
				if (agentId) params.set('agentId', agentId);
				const response = await api(`/portal/chat/history?${params}`);
				if (!response.ok) return [];
				const data = await response.json();
				const messages = data.messages || [];
				if (messages.length > 0) {
					set(messages);
					hasLoaded = true;
				}
				return messages;
			} catch {
				return [];
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
