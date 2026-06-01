/**
 * GuardianRegistry — one per process. Addresses guardians by stable ID.
 *
 * Workers and the VPS agent-server each hold their own registry instance;
 * fleet reports aggregate across registries using {process_id, guardian_id}.
 */

import { Guardian } from './guardian.js';

export class GuardianRegistry {
  constructor() {
    this._map = new Map();
  }

  /**
   * Register a guardian. Accepts either a Guardian instance or a spec object.
   * Throws if the ID is already taken.
   */
  register(specOrInstance) {
    const g = specOrInstance instanceof Guardian
      ? specOrInstance
      : new Guardian(specOrInstance);
    if (this._map.has(g.id)) {
      throw new Error(`guardian '${g.id}' already registered`);
    }
    this._map.set(g.id, g);
    return g;
  }

  get(id) { return this._map.get(id); }
  has(id) { return this._map.has(id); }
  all() { return [...this._map.values()]; }
  ids() { return [...this._map.keys()]; }
  size() { return this._map.size; }

  /** Full snapshot — for /admin/guardians + dashboards. */
  snapshot() {
    return {
      generated_at: Date.now(),
      count: this._map.size,
      guardians: this.all().map(g => g.snapshot()),
    };
  }

  /** Metrics-only snapshot — for fleet reports (small). */
  metricsSnapshot() {
    return {
      generated_at: Date.now(),
      count: this._map.size,
      guardians: this.all().map(g => g.metricsSnapshot()),
    };
  }
}

/**
 * Process-local singleton. Import this in VPS code.
 * Workers should instantiate their own `new GuardianRegistry()` since
 * module state doesn't persist between isolates across deploys cleanly.
 */
export const guardians = new GuardianRegistry();
