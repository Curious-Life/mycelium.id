// Connector framework entry point — registers the built-in adapters and
// re-exports the runner/scheduler/registry surface.
//
// Phase 2 ships the framework + scheduler + the mock adapter (dev/CI only).
// Phase 3 registers the real Gmail + Linear adapters here.

import { registerAdapter } from './registry.js';
import { mockAdapter } from './adapters/mock.js';

let _registered = false;

/**
 * Register built-in adapters exactly once. The mock adapter is only registered
 * when MYCELIUM_CONNECTORS_MOCK=1 (dev/preview) so it never appears in a real
 * vault. Real adapters (gmail, linear) will be registered unconditionally here
 * in Phase 3.
 */
export function registerBuiltinAdapters({ includeMock = process.env.MYCELIUM_CONNECTORS_MOCK === '1' } = {}) {
  if (_registered) return;
  _registered = true;
  if (includeMock) registerAdapter(mockAdapter);
}

export { createConnectorRunner, startConnectorScheduler } from './scheduler.js';
export { registerAdapter, getAdapter, listAdapters, _resetRegistry } from './registry.js';
export { createConnectorStore } from './store.js';
