// Connector framework entry point — registers the built-in adapters and
// re-exports the runner/scheduler/registry surface.
//
// Phase 2 ships the framework + scheduler + the mock adapter (dev/CI only).
// Phase 3 registers the real Gmail + Linear adapters here.

import { registerAdapter } from './registry.js';
import { mockAdapter } from './adapters/mock.js';
import { gmailAdapter } from './adapters/gmail.js';
import { linearAdapter } from './adapters/linear.js';

let _registered = false;

/**
 * Register built-in adapters exactly once. Gmail + Linear are always available
 * (they surface as "disconnected" until creds are configured). The mock adapter
 * is only registered when MYCELIUM_CONNECTORS_MOCK=1 (dev/preview/CI) so it
 * never appears in a real vault.
 */
export function registerBuiltinAdapters({ includeMock = process.env.MYCELIUM_CONNECTORS_MOCK === '1' } = {}) {
  if (_registered) return;
  _registered = true;
  registerAdapter(gmailAdapter);
  registerAdapter(linearAdapter);
  if (includeMock) registerAdapter(mockAdapter);
}

export { createConnectorRunner, startConnectorScheduler } from './scheduler.js';
export { registerAdapter, getAdapter, listAdapters, _resetRegistry } from './registry.js';
export { createConnectorStore } from './store.js';
