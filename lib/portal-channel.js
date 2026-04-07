/**
 * Encrypted Portal WebSocket Channel — Server Integration
 *
 * Attaches a WebSocket server at /ws/secure that handles:
 *   1. Noise NK handshake
 *   2. Channel-bound re-authentication via passkey
 *   3. Encrypted frame routing to portal handlers
 *   4. Heartbeat + idle timeout + rekey
 *
 * The WS endpoint is mounted on the same HTTP server as Express,
 * filtered to the /ws/secure path only.
 */

import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { NoiseNKResponder, encryptFrame, decryptFrame } from './noise-nk-server.js';

const HEARTBEAT_INTERVAL = 25_000;  // 25 seconds
const IDLE_TIMEOUT = 30 * 60_000;   // 30 minutes
const REKEY_BYTES = 1_073_741_824;  // 1 GiB
const REKEY_INTERVAL = 3_600_000;   // 1 hour
const REQUEST_TIMEOUT = 30_000;     // 30 seconds for handler response

/**
 * Set up the encrypted portal channel on an existing HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {Object} options
 * @param {Object} options.identity - From loadIdentity(): { noisePriv, noisePub, fingerprint }
 * @param {Function} options.authenticateSession - async (token) => user | null
 * @param {Object} options.routes - Map of type → async (data, user) => result
 * @param {Object} options.streamRoutes - Map of type → async (data, user, emit) => void
 * @param {Function} [options.getAuthModule] - async () => auth module with generateChallenge/verifyAssertion
 */
export function setupSecureChannel(httpServer, options) {
  const { identity, authenticateSession, routes = {}, streamRoutes = {}, getAuthModule } = options;

  const responder = new NoiseNKResponder(identity.noisePriv, identity.noisePub);

  const wss = new WebSocketServer({ noServer: true });

  // Channel state per connection
  const channels = new Map();

  // ── HTTP upgrade handler ──
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname !== '/ws/secure') return; // let other upgrade handlers pass

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // ── Connection handler ──
  wss.on('connection', (ws, request) => {
    const id = randomBytes(8).toString('hex');
    const channel = {
      id,
      ws,
      state: 'handshaking', // handshaking → authenticating → ready
      sendCipher: null,
      recvCipher: null,
      user: null,
      channelToken: null,
      bytesSent: 0,
      bytesRecv: 0,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    channels.set(id, channel);

    // Extract session token from cookie or query param for initial auth context
    const cookies = parseCookies(request.headers.cookie || '');
    const bootstrapToken = cookies.mycelium_session || null;

    // ── Heartbeat ──
    let heartbeatTimer = null;
    let pongReceived = true;

    function startHeartbeat() {
      heartbeatTimer = setInterval(() => {
        if (!pongReceived) {
          ws.close(1001, 'Heartbeat timeout');
          return;
        }
        pongReceived = false;
        if (channel.state === 'ready' && channel.sendCipher) {
          try {
            const ping = encryptFrame(channel.sendCipher, Buffer.from(JSON.stringify({ type: 'ping' })));
            channel.bytesSent += ping.length;
            ws.send(ping);
          } catch { /* connection closing */ }
        }
      }, HEARTBEAT_INTERVAL);
    }

    // ── Idle timeout ──
    let idleTimer = setTimeout(() => {
      ws.close(1000, 'Idle timeout');
    }, IDLE_TIMEOUT);

    function resetIdle() {
      channel.lastActivity = Date.now();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ws.close(1000, 'Idle timeout'), IDLE_TIMEOUT);
    }

    // ── Message handler ──
    ws.on('message', async (data) => {
      try {
        const msg = Buffer.from(data);

        if (channel.state === 'handshaking') {
          // Process Noise NK handshake
          const respPayload = JSON.stringify({
            serverNonce: randomBytes(16).toString('hex'),
            fingerprint: identity.fingerprint,
          });

          const result = responder.processHandshake(msg, Buffer.from(respPayload));

          channel.sendCipher = result.sendCipher;
          channel.recvCipher = result.recvCipher;

          // Parse initiator payload
          let initPayload;
          try {
            initPayload = JSON.parse(result.initiatorPayload.toString());
          } catch {
            initPayload = {};
          }

          // Send handshake response
          ws.send(result.response);

          // Transition to authenticating
          channel.state = 'authenticating';
          startHeartbeat();

          // If we have a bootstrap session token, validate it to establish user identity
          if (bootstrapToken) {
            const user = await authenticateSession(bootstrapToken);
            if (user) {
              // Generate channel-bound token
              channel.user = user;
              channel.channelToken = randomBytes(32).toString('hex');
              channel.state = 'ready';

              // Send auth success
              const authSuccess = encryptFrame(channel.sendCipher, Buffer.from(JSON.stringify({
                type: 'auth_success',
                data: { channelToken: channel.channelToken, userId: user.id },
              })));
              channel.bytesSent += authSuccess.length;
              ws.send(authSuccess);
            } else {
              // Send auth required
              sendEncrypted(channel, { type: 'auth_required', data: { reason: 'Invalid session' } });
            }
          } else {
            sendEncrypted(channel, { type: 'auth_required', data: { reason: 'No session' } });
          }
          return;
        }

        // All post-handshake messages are encrypted
        channel.bytesRecv += msg.length;
        resetIdle();

        let frame;
        try {
          frame = decryptFrame(channel.recvCipher, msg);
        } catch (err) {
          ws.close(1002, 'Decryption failed');
          return;
        }

        let payload;
        try {
          payload = JSON.parse(frame.toString());
        } catch {
          ws.close(1002, 'Invalid JSON');
          return;
        }

        // Handle pong
        if (payload.type === 'pong') {
          pongReceived = true;
          return;
        }

        // Check channel token for all non-auth messages
        if (channel.state === 'ready') {
          if (payload.channelToken !== channel.channelToken) {
            sendEncrypted(channel, {
              id: payload.id,
              type: 'error',
              data: { error: 'Invalid channel token', code: 401 },
            });
            return;
          }
        }

        // Handle rekey notification from client
        if (payload.type === 'rekey') {
          channel.recvCipher.rekey();
          channel.sendCipher.rekey();
          channel.bytesSent = 0;
          channel.bytesRecv = 0;
          sendEncrypted(channel, { type: 'rekey_ack' });
          return;
        }

        // Route to handler
        const { id: reqId, type, data } = payload;

        if (!reqId || !type) {
          sendEncrypted(channel, {
            id: reqId,
            type: 'error',
            data: { error: 'Missing id or type', code: 400 },
          });
          return;
        }

        if (!channel.user) {
          sendEncrypted(channel, {
            id: reqId,
            type: 'error',
            data: { error: 'Not authenticated', code: 401 },
          });
          return;
        }

        // Check if it's a streaming route
        if (streamRoutes[type]) {
          try {
            await streamRoutes[type](data || {}, channel.user, (event) => {
              sendEncrypted(channel, { id: reqId, type: 'stream-chunk', data: event });
            });
            sendEncrypted(channel, { id: reqId, type: 'stream-end' });
          } catch (err) {
            sendEncrypted(channel, {
              id: reqId,
              type: 'error',
              data: { error: err.message, code: err.status || 500 },
            });
          }
          return;
        }

        // Regular request/response route
        if (routes[type]) {
          try {
            const result = await routes[type](data || {}, channel.user);
            sendEncrypted(channel, { id: reqId, type: 'response', data: result });
          } catch (err) {
            sendEncrypted(channel, {
              id: reqId,
              type: 'error',
              data: { error: err.message, code: err.status || 500 },
            });
          }
          return;
        }

        // Unknown type
        sendEncrypted(channel, {
          id: reqId,
          type: 'error',
          data: { error: `Unknown message type: ${type}`, code: 404 },
        });

        // Check rekey threshold
        maybeRekey(channel);

      } catch (err) {
        console.error(`[secure-channel:${id}] Error:`, err.message);
        ws.close(1011, 'Internal error');
      }
    });

    // ── Close handler ──
    ws.on('close', () => {
      clearInterval(heartbeatTimer);
      clearTimeout(idleTimer);
      channels.delete(id);
    });

    ws.on('error', (err) => {
      console.error(`[secure-channel:${id}] WS error:`, err.message);
    });
  });

  console.log('[secure-channel] WebSocket server mounted on /ws/secure');
  return { wss, channels };
}

// ── Helpers ──

function sendEncrypted(channel, payload) {
  if (!channel.sendCipher || channel.ws.readyState !== 1) return;
  try {
    const frame = encryptFrame(channel.sendCipher, Buffer.from(JSON.stringify(payload)));
    channel.bytesSent += frame.length;
    channel.ws.send(frame);
  } catch { /* connection closing */ }
}

function maybeRekey(channel) {
  if (channel.bytesSent > REKEY_BYTES || channel.bytesRecv > REKEY_BYTES) {
    sendEncrypted(channel, { type: 'rekey' });
    channel.sendCipher.rekey();
    channel.recvCipher.rekey();
    channel.bytesSent = 0;
    channel.bytesRecv = 0;
  }
  if (Date.now() - channel.createdAt > REKEY_INTERVAL) {
    sendEncrypted(channel, { type: 'rekey' });
    channel.sendCipher.rekey();
    channel.recvCipher.rekey();
    channel.createdAt = Date.now();
    channel.bytesSent = 0;
    channel.bytesRecv = 0;
  }
}

function parseCookies(cookieStr) {
  const cookies = {};
  for (const part of cookieStr.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  }
  return cookies;
}
