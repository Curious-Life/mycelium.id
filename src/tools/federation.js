/**
 * Federation domain (Tier-0) — request and manage cross-instance connections.
 *
 * Tools:
 *   requestConnection         — ask to connect to @handle@domain (signed via did:web).
 *   listConnectionRequests    — pending inbound requests awaiting your response.
 *   respondToConnectionRequest— accept / reject / block a pending request.
 *
 * All cross-instance crypto (signing outbound, verifying inbound) lives in the
 * connections namespace + the federation router; this domain is the user-facing
 * verb surface. Handlers receive only `args` and close over `db`/`userId`.
 *
 * @typedef {object} FederationDeps
 * @property {object} db — needs db.connections.{request, pending, accept, reject, block}
 * @property {string} userId
 */

export function createFederationDomain(deps) {
  if (!deps) throw new TypeError('createFederationDomain: deps required');
  const { db, userId } = deps;
  if (!db) throw new TypeError('createFederationDomain: db required');
  if (typeof userId !== 'string') throw new TypeError('createFederationDomain: userId required');

  const tools = [
    {
      name: 'requestConnection',
      description: 'Request a connection to another Mycelium instance by federated handle (e.g. "@alice@alice.mycelium.id"). The request is cryptographically signed with your instance identity and delivered to the peer, where it waits for them to accept. Requires your own remote access (public handle) to be configured.',
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: 'Federated handle: @handle@domain or handle@domain' },
        },
        required: ['handle'],
      },
    },
    {
      name: 'listConnectionRequests',
      description: 'List pending inbound connection requests from other instances that are awaiting your response.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'respondToConnectionRequest',
      description: 'Respond to a pending connection request: accept it, reject it (they may re-request later), or block the peer (future requests silently fail).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The connection request id (from listConnectionRequests).' },
          action: { type: 'string', enum: ['accept', 'reject', 'block'], description: 'What to do with the request.' },
        },
        required: ['id', 'action'],
      },
    },
  ];

  const handlers = {
    requestConnection: async (args) => {
      if (!db.connections) return 'Federation is not available on this vault.';
      const handle = String(args?.handle || '').trim().replace(/^@/, '');
      if (!handle.includes('@')) return 'Provide a federated handle as @handle@domain (e.g. @alice@alice.mycelium.id).';
      try {
        const id = await db.connections.request(userId, handle);
        return `Connection request sent to @${handle} (id ${id}). It will appear in their pending requests; you'll be connected once they accept.`;
      } catch (e) {
        return `Could not send the request: ${e.message}`;
      }
    },

    listConnectionRequests: async () => {
      if (!db.connections) return 'Federation is not available on this vault.';
      const rows = await db.connections.pending(userId);
      if (!rows.length) return 'No pending connection requests.';
      const lines = rows.map((r) => {
        const who = r.display_name || r.handle || r.remote_user_handle || r.initiated_by;
        const sig = r.signature ? ` — "${r.signature}"` : '';
        return `• ${who}${sig}\n  id: ${r.id}`;
      });
      return `Pending connection requests (${rows.length}):\n\n${lines.join('\n')}`;
    },

    respondToConnectionRequest: async (args) => {
      if (!db.connections) return 'Federation is not available on this vault.';
      const id = String(args?.id || '').trim();
      const action = String(args?.action || '').trim();
      if (!id) return 'Provide the connection request id.';
      try {
        // respondRemote (not accept) so a federated accept fires the signed
        // connect-response that completes the peer's side of the handshake.
        if (action === 'accept') { await db.connections.respondRemote(userId, id, 'accept'); return 'Connection accepted.'; }
        if (action === 'reject') { await db.connections.reject(userId, id); return 'Connection request rejected.'; }
        if (action === 'block') { await db.connections.block(userId, id); return 'Peer blocked.'; }
        return 'Unknown action — use accept, reject, or block.';
      } catch (e) {
        return `Could not ${action} the request: ${e.message}`;
      }
    },
  };

  return { tools, handlers };
}
