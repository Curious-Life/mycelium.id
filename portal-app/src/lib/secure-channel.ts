/**
 * Encrypted WebSocket Channel — Browser Client
 *
 * Singleton WebSocket connection to the VPS encrypted portal channel.
 * Handles Noise NK handshake, authentication, frame routing,
 * heartbeat, reconnection, and request/response correlation.
 *
 * Usage:
 *   import { getChannel } from '$lib/secure-channel';
 *   const channel = getChannel();
 *   const result = await channel.request('messages', { limit: 50 });
 *   await channel.requestStream('chat', { message: 'hello' }, (chunk) => { ... });
 */

import { NoiseNKInitiator, CipherState, encryptFrame, decryptFrame } from './noise-nk';
import { getVpsNoisePublicKey } from './vps-identity';

export type ChannelState = 'disconnected' | 'connecting' | 'handshaking' | 'authenticating' | 'ready' | 'error';

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	onChunk?: (chunk: unknown) => void;
};

type StateCallback = (state: ChannelState) => void;

const REQUEST_TIMEOUT = 30_000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_INTERVAL = 25_000;

let _instance: SecureChannel | null = null;

export function getChannel(): SecureChannel {
	if (!_instance) {
		_instance = new SecureChannel();
	}
	return _instance;
}

export class SecureChannel {
	state: ChannelState = 'disconnected';
	private ws: WebSocket | null = null;
	private sendCipher: CipherState | null = null;
	private recvCipher: CipherState | null = null;
	private channelToken: string | null = null;
	private initiator: NoiseNKInitiator | null = null;
	private pending = new Map<string, PendingRequest>();
	private stateListeners = new Set<StateCallback>();
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reqCounter = 0;
	private _connectReject: ((reason: Error) => void) | null = null;

	/** True when the channel is authenticated and ready to send requests. */
	get available(): boolean {
		return this.state === 'ready';
	}

	/** Connect and perform handshake. Resolves when ready. */
	async connect(): Promise<void> {
		if (this.state === 'ready') return;
		if (this.state === 'connecting' || this.state === 'handshaking' || this.state === 'authenticating') {
			// Already connecting — wait for it
			return new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => { reject(new Error('Channel connect timeout')); }, 15_000);
				const unsub = this.onStateChange((s) => {
					if (s === 'ready') { clearTimeout(timeout); unsub(); resolve(); }
					if (s === 'error' || s === 'disconnected') { clearTimeout(timeout); unsub(); reject(new Error('Channel failed')); }
				});
			});
		}

		const vpsPub = getVpsNoisePublicKey();
		if (!vpsPub) {
			this.setState('error');
			throw new Error('VPS identity key not configured');
		}

		this.setState('connecting');

		return new Promise<void>((resolve, reject) => {
			this._connectReject = reject;
			const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/secure`;

			try {
				this.ws = new WebSocket(wsUrl);
				this.ws.binaryType = 'arraybuffer';
			} catch (err) {
				this.setState('error');
				reject(err as Error);
				return;
			}

			this.ws.onopen = () => {
				this.setState('handshaking');
				this.initiator = new NoiseNKInitiator(vpsPub);

				const payload = new TextEncoder().encode(JSON.stringify({
					clientNonce: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
					version: 1,
				}));
				const msg1 = this.initiator.createInitiatorMessage(payload);
				this.ws!.send(msg1);
			};

			let handshakeProcessed = false;

			this.ws.onmessage = (event) => {
				const msgData = new Uint8Array(event.data as ArrayBuffer);

				if (this.state === 'handshaking' && !handshakeProcessed) {
					handshakeProcessed = true;
					try {
						const result = this.initiator!.processResponderMessage(msgData);
						this.sendCipher = result.sendCipher;
						this.recvCipher = result.recvCipher;
						this.setState('authenticating');
						this.startHeartbeat();
					} catch (err) {
						this.setState('error');
						reject(new Error('Handshake failed: ' + (err as Error).message));
						this.ws?.close();
					}
					return;
				}

				if (!this.recvCipher) return;

				try {
					const plaintext = decryptFrame(this.recvCipher, msgData);
					const payload = JSON.parse(new TextDecoder().decode(plaintext));
					this.handlePayload(payload, resolve, reject);
				} catch (err) {
					console.error('[secure-channel] Frame decryption failed:', (err as Error).message);
				}
			};

			this.ws.onclose = () => {
				const wasReady = this.state === 'ready';
				this.cleanup();
				this.setState('disconnected');
				// Only auto-reconnect if the channel was previously working
				// Don't reconnect if we never got past auth (avoids infinite loop)
				if (wasReady) {
					this.scheduleReconnect();
				}
			};

			this.ws.onerror = () => {
				if (this.state !== 'ready') {
					reject(new Error('WebSocket connection failed'));
				}
			};

			setTimeout(() => {
				if (this.state !== 'ready') {
					this.ws?.close();
					reject(new Error('Connection timeout'));
				}
			}, 15_000);
		});
	}

	disconnect(): void {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.ws?.close(1000, 'Client disconnect');
		this.cleanup();
		this.setState('disconnected');
	}

	/** Send a request and wait for a response. */
	async request(type: string, data: Record<string, unknown> = {}): Promise<unknown> {
		await this.ensureReady();

		const id = `req_${++this.reqCounter}_${Date.now()}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request timeout: ${type}`));
			}, REQUEST_TIMEOUT);

			this.pending.set(id, { resolve, reject, timeout });
			this.sendFrame({ id, type, data, channelToken: this.channelToken });
		});
	}

	/** Send a streaming request. onChunk called for each stream-chunk. */
	async requestStream(
		type: string,
		data: Record<string, unknown>,
		onChunk: (chunk: unknown) => void
	): Promise<void> {
		await this.ensureReady();

		const id = `req_${++this.reqCounter}_${Date.now()}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Stream timeout: ${type}`));
			}, 5 * 60_000);

			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout, onChunk });
			this.sendFrame({ id, type, data, channelToken: this.channelToken });
		});
	}

	onStateChange(callback: StateCallback): () => void {
		this.stateListeners.add(callback);
		return () => this.stateListeners.delete(callback);
	}

	// ── Internal ──

	private handlePayload(
		payload: Record<string, unknown>,
		connectResolve?: (value?: void) => void,
		connectReject?: (reason: Error) => void
	): void {
		const { type, id, data } = payload as { type: string; id?: string; data?: unknown };

		if (type === 'auth_success') {
			const authData = data as { channelToken: string; userId: string };
			this.channelToken = authData.channelToken;
			this.setState('ready');
			this.reconnectAttempt = 0;
			this._connectReject = null;
			connectResolve?.();
			return;
		}

		if (type === 'auth_required') {
			// Auth failed — reject the connect() promise so callers get an error
			// Don't schedule reconnect — the user needs to log in first
			this.setState('error');
			const err = new Error('Secure channel auth failed — no valid session');
			connectReject?.(err);
			this._connectReject = null;
			this.ws?.close();
			return;
		}

		if (type === 'ping') {
			this.sendFrame({ type: 'pong' });
			return;
		}

		if (type === 'rekey') {
			this.sendCipher?.rekey();
			this.recvCipher?.rekey();
			this.sendFrame({ type: 'rekey_ack' });
			return;
		}

		if (type === 'rekey_ack') return;

		// Dispatch to pending request
		if (id && this.pending.has(id)) {
			const req = this.pending.get(id)!;

			if (type === 'stream-chunk' && req.onChunk) {
				req.onChunk(data);
				return;
			}

			if (type === 'stream-end') {
				clearTimeout(req.timeout);
				this.pending.delete(id);
				req.resolve(undefined);
				return;
			}

			if (type === 'response') {
				clearTimeout(req.timeout);
				this.pending.delete(id);
				req.resolve(data);
				return;
			}

			if (type === 'error') {
				clearTimeout(req.timeout);
				this.pending.delete(id);
				const errData = data as { error?: string; code?: number };
				const err = new Error(errData?.error || 'Server error');
				(err as Error & { status?: number }).status = errData?.code || 500;
				req.reject(err);
				return;
			}
		}
	}

	private sendFrame(payload: Record<string, unknown>): void {
		if (!this.sendCipher || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		const plaintext = new TextEncoder().encode(JSON.stringify(payload));
		const frame = encryptFrame(this.sendCipher, plaintext);
		this.ws.send(frame);
	}

	private async ensureReady(): Promise<void> {
		if (this.state === 'ready') return;
		if (this.state === 'disconnected' || this.state === 'error') {
			await this.connect();
			return;
		}
		// Wait for current connection attempt
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Channel not ready')), 15_000);
			const unsub = this.onStateChange((state) => {
				if (state === 'ready') { clearTimeout(timeout); unsub(); resolve(); }
				if (state === 'error' || state === 'disconnected') { clearTimeout(timeout); unsub(); reject(new Error('Channel failed')); }
			});
		});
	}

	private setState(state: ChannelState): void {
		this.state = state;
		for (const cb of this.stateListeners) {
			try { cb(state); } catch { /* ignore listener errors */ }
		}
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			if (this.state === 'ready') {
				this.sendFrame({ type: 'pong' });
			}
		}, HEARTBEAT_INTERVAL);
	}

	private cleanup(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		this.sendCipher = null;
		this.recvCipher = null;
		this.channelToken = null;
		this.initiator = null;
		this._connectReject = null;
		for (const [, req] of this.pending) {
			clearTimeout(req.timeout);
			req.reject(new Error('Channel closed'));
		}
		this.pending.clear();
	}

	private scheduleReconnect(): void {
		const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.connect().catch(() => {});
		}, delay);
	}
}
