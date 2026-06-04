// Mock connector adapter — no network, no OAuth. Exists so the connector
// framework (connect → encrypted token store → scheduler pull → captureMessage
// → dedupe → status → disconnect) is fully verifiable in CI. Real adapters
// (Gmail, Linear) follow the same shape in Phase 3.

// A small fixed "remote" dataset. pull() returns the slice after the cursor
// (an integer index) and advances nextCursor — modelling incremental sync.
const DATASET = [
  { extId: 'm1', subject: 'First mock item', body: 'hello from the mock connector (1)', at: '2026-01-01T00:00:00Z' },
  { extId: 'm2', subject: 'Second mock item', body: 'hello from the mock connector (2)', at: '2026-01-02T00:00:00Z' },
  { extId: 'm3', subject: 'Third mock item', body: 'hello from the mock connector (3)', at: '2026-01-03T00:00:00Z' },
];

export const mockAdapter = {
  id: 'mock',
  label: 'Mock Connector',
  provider: 'mock',
  oauth: null, // non-OAuth: connect stores a local token directly
  async pull(_ctx, { cursor } = {}) {
    const start = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    const slice = DATASET.slice(start);
    const items = slice.map((d) => ({
      // captureMessage args — deterministic id ⇒ re-pull dedupes
      content: `# ${d.subject}\n\n${d.body}`,
      source: 'mock',
      id: `mock:${d.extId}`,
      messageType: 'connector',
      createdAt: d.at,
      metadata: { connector: 'mock', extId: d.extId, subject: d.subject },
    }));
    return { items, nextCursor: String(DATASET.length) };
  },
};
