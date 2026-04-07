/**
 * Tenant-aware D1 routing.
 *
 * Owner (default tenant) uses the primary D1 binding (env.DB).
 * Other tenants use per-tenant D1 bindings (env.DB_TENANT_<tenant_id>).
 *
 * Tenant D1 bindings are declared in wrangler.toml:
 *   [[d1_databases]]
 *   binding = "DB_TENANT_<tenant_id>"
 *   database_name = "mycelium-tenant-<handle>"
 *   database_id = "<uuid>"
 *
 * TENANT_REGISTRY secret maps tenant_id → d1_id for validation,
 * but actual routing uses the wrangler binding for speed.
 */

import type { Env } from "../types/env";

/**
 * Get the D1 database for a given tenant.
 *
 * - No tenant header → env.DB (owner)
 * - Known tenant with binding → env[DB_TENANT_xxx] (fast D1 binding)
 * - Unknown tenant → env.DB (fallback to owner — safe because user_id filtering)
 */
export function getD1ForTenant(
  env: Env,
  tenantId: string | null,
): D1Database | null {
  // No tenant header → owner's DB
  if (!tenantId) return env.DB || null;

  // Look for a tenant-specific D1 binding
  const bindingKey = `DB_TENANT_${tenantId}`;
  const tenantDb = (env as unknown as Record<string, D1Database>)[bindingKey];

  if (tenantDb) {
    return tenantDb;
  }

  // No binding found — log warning and fall back to owner's DB
  // TODO: Once all tenants are migrated, change this to return null (reject)
  console.warn(`[tenant-d1] No binding for tenant ${tenantId} (expected ${bindingKey}) — falling back to owner DB`);
  return env.DB || null;
}

/**
 * Extract tenant ID from request headers.
 * VPS sends X-Tenant-ID (= MYA_USER_ID) with every request.
 */
export function extractTenantId(request: Request): string | null {
  return request.headers.get("X-Tenant-ID") || null;
}
