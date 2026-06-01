import { writable } from 'svelte/store';

export interface Toast {
	id: string;
	message: string;
	type: 'info' | 'success' | 'error';
	duration?: number;
}

function createToastStore() {
	const { subscribe, update } = writable<Toast[]>([]);

	function add(message: string, type: Toast['type'] = 'info', duration = 4000) {
		const id = crypto.randomUUID();
		update((toasts) => [...toasts, { id, message, type, duration }]);
		if (duration > 0) {
			setTimeout(() => remove(id), duration);
		}
		return id;
	}

	function remove(id: string) {
		update((toasts) => toasts.filter((t) => t.id !== id));
	}

	return {
		subscribe,
		info: (message: string, duration?: number) => add(message, 'info', duration),
		success: (message: string, duration?: number) => add(message, 'success', duration),
		error: (message: string, duration?: number) => add(message, 'error', duration),
		remove,
	};
}

export const toasts = createToastStore();
