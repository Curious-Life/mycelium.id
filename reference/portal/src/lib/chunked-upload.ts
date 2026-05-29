/**
 * Chunked file upload — splits large files into 50MB pieces and uploads sequentially.
 * Uses File.slice() which is zero-copy (no memory allocation).
 * Retries failed chunks up to 3 times with exponential backoff.
 * Falls back to single-request upload for files under 100MB.
 */

const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

function getCsrfToken(): string | null {
	const match = document.cookie.match(/mycelium_csrf=([^;]+)/);
	return match ? match[1] : null;
}

async function uploadChunkWithRetry(blob: Blob, uploadId: string, index: number, filename: string): Promise<void> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const formData = new FormData();
			formData.append('chunk', blob);
			formData.append('uploadId', uploadId);
			formData.append('index', String(index));
			formData.append('filename', filename);

			const headers: Record<string, string> = {};
			const csrf = getCsrfToken();
			if (csrf) headers['X-CSRF-Token'] = csrf;

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min per chunk

			const res = await fetch('/portal/upload/chunk', {
				method: 'POST', body: formData, credentials: 'same-origin', headers,
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (res.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return; // success
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
			if (lastError.message === 'Session expired') throw lastError;
			if (attempt < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
				console.warn(`[upload] Chunk ${index} attempt ${attempt} failed: ${lastError.message}, retrying in ${delay}ms`);
				await new Promise(r => setTimeout(r, delay));
			}
		}
	}
	throw new Error(`Chunk ${index} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

export interface UploadProgress {
	loaded: number;
	total: number;
	percent: number;
	stage: string;
	chunk?: number;
	totalChunks?: number;
}

export async function uploadFile(
	file: File,
	onProgress?: (p: UploadProgress) => void,
): Promise<any> {
	const total = file.size;

	if (total <= 100_000_000) {
		// Small file: single request with XHR progress
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', '/portal/upload');
			xhr.withCredentials = true;
			const csrf = getCsrfToken();
			if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable && onProgress) {
					onProgress({ loaded: e.loaded, total: e.total, percent: Math.round((e.loaded / e.total) * 100), stage: 'uploading' });
				}
			};
			xhr.onload = () => {
				if (xhr.status === 401) { window.location.href = '/login'; reject(new Error('Session expired')); return; }
				if (xhr.status >= 400) { reject(new Error(`Upload failed (${xhr.status})`)); return; }
				try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('Invalid response')); }
			};
			xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
			xhr.timeout = 0;
			const formData = new FormData();
			formData.append('file', file);
			xhr.send(formData);
		});
	}

	// Large file: chunked upload with retry
	const uploadId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const totalChunks = Math.ceil(total / CHUNK_SIZE);

	for (let i = 0; i < totalChunks; i++) {
		const start = i * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, total);
		const chunk = file.slice(start, end);
		await uploadChunkWithRetry(chunk, uploadId, i, file.name);
		if (onProgress) {
			onProgress({
				loaded: end, total,
				percent: Math.round(((i + 1) / totalChunks) * 100),
				stage: 'uploading',
				chunk: i + 1,
				totalChunks,
			});
		}
	}

	// Signal completion
	if (onProgress) onProgress({ loaded: total, total, percent: 100, stage: 'processing' });

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	const csrf = getCsrfToken();
	if (csrf) headers['X-CSRF-Token'] = csrf;

	// Completion can take a while (ZIP extraction + import) — long timeout
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 600_000); // 10 min for processing

	const res = await fetch('/portal/upload/complete', {
		method: 'POST', credentials: 'same-origin', headers,
		body: JSON.stringify({ uploadId, filename: file.name, totalChunks, fileSize: total }),
		signal: controller.signal,
	});
	clearTimeout(timeout);

	if (res.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Import processing failed (${res.status}): ${body.substring(0, 200)}`);
	}
	return res.json();
}
