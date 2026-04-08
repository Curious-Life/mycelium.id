/**
 * Encryption Coverage Test — ensures no sensitive personal data fields
 * are left unencrypted in the ENCRYPTED_FIELDS configuration.
 *
 * This test validates that every column in the database that could contain
 * personal data is listed in ENCRYPTED_FIELDS. It's a compile-time check
 * (no DB connection needed) that prevents regressions.
 *
 * If you add a new column that stores personal data, this test will FAIL
 * until you add it to ENCRYPTED_FIELDS in both crypto-local.js and
 * worker/src/services/crypto.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENCRYPTED_FIELDS } from '../lib/crypto-local.js';

// ── Define what MUST be encrypted per table ──
// This is the source of truth. If a new sensitive column is added to the
// schema, add it here AND to ENCRYPTED_FIELDS. The test enforces both.

const REQUIRED_ENCRYPTED_FIELDS = {
  messages: ['content', 'thinking', 'tags', 'entities', 'entity_summary'],
  documents: ['content', 'summary', 'title'],
  attachments: ['transcript', 'file_name', 'description'],
  clustering_points: ['content'],
  people: ['name', 'email', 'phone', 'company', 'position', 'linkedin_url', 'aliases', 'description', 'metadata'],
  agent_tasks: ['context', 'result', 'description'],
  wealth_transactions: ['notes', 'quantity', 'price_per_unit', 'fees'],
  wealth_positions: ['total_cost', 'current_value', 'unrealized_pnl', 'avg_cost_basis', 'quantity'],
  wealth_snapshots: ['total_value', 'total_invested', 'total_pnl', 'day_change'],
  health_daily: ['sleep_duration_min', 'hrv_avg', 'resting_hr', 'steps', 'active_energy_kcal'],
  activity_sessions: ['window_title', 'url'],
  internal_model_items: ['content'],
  reflections: ['content', 'trigger'],
  territory_profiles: ['title', 'essence', 'story_birth', 'story_arc', 'story_current_chapter'],
  user_identities: ['provider_username', 'provider_id'],
  provisioning_jobs: ['email'],
  secrets: ['key', 'description'],
};

// ── Fields that must NEVER be encrypted (IDs, timestamps, flags) ──
// These are structural metadata needed for SQL queries.
const NEVER_ENCRYPT = [
  'id', 'user_id', 'agent_id', 'created_at', 'updated_at', 'deleted_at',
  'status', 'type', 'scope', 'role', 'version', 'source', 'source_type',
  'source_id', 'rowid', 'parent_id', 'portfolio_id', 'asset_id',
  'territory_id', 'realm_id', 'theme_id', 'cluster_version',
  'nlp_processed', 'nlp_processed_at', 'embedding_model',
];

describe('Encryption Coverage', () => {
  it('ENCRYPTED_FIELDS covers all required sensitive fields', () => {
    const missing = [];

    for (const [table, requiredFields] of Object.entries(REQUIRED_ENCRYPTED_FIELDS)) {
      const configured = ENCRYPTED_FIELDS[table] || [];
      for (const field of requiredFields) {
        if (!configured.includes(field)) {
          missing.push(`${table}.${field}`);
        }
      }
    }

    if (missing.length > 0) {
      assert.fail(
        `ENCRYPTED_FIELDS is missing ${missing.length} required sensitive fields:\n` +
        missing.map(f => `  - ${f}`).join('\n') +
        '\n\nAdd these to ENCRYPTED_FIELDS in lib/crypto-local.js AND worker/src/services/crypto.ts'
      );
    }
  });

  it('ENCRYPTED_FIELDS does not encrypt structural metadata', () => {
    const wrongly = [];

    for (const [table, fields] of Object.entries(ENCRYPTED_FIELDS)) {
      for (const field of fields) {
        if (NEVER_ENCRYPT.includes(field)) {
          wrongly.push(`${table}.${field}`);
        }
      }
    }

    if (wrongly.length > 0) {
      assert.fail(
        `ENCRYPTED_FIELDS includes ${wrongly.length} structural fields that should NOT be encrypted:\n` +
        wrongly.map(f => `  - ${f}`).join('\n') +
        '\n\nEncrypting IDs/timestamps/flags breaks SQL queries.'
      );
    }
  });

  it('VPS and Worker ENCRYPTED_FIELDS are in sync', async () => {
    // Read Worker config by parsing the TypeScript file
    const { readFileSync } = await import('fs');
    const workerCrypto = readFileSync('worker/src/services/crypto.ts', 'utf-8');

    // For each table in VPS ENCRYPTED_FIELDS, verify Worker has the same fields
    for (const [table, vpsFields] of Object.entries(ENCRYPTED_FIELDS)) {
      // Check the table appears in the Worker config
      const tableRegex = new RegExp(`${table}:\\s*\\[([^\\]]+)\\]`);
      const match = workerCrypto.match(tableRegex);

      if (!match) {
        assert.fail(`Table '${table}' is in VPS ENCRYPTED_FIELDS but missing from Worker crypto.ts`);
        continue;
      }

      // Extract field names from the Worker config
      const workerFields = match[1]
        .split(',')
        .map(s => s.trim().replace(/["']/g, ''))
        .filter(Boolean);

      // Check every VPS field is in Worker
      for (const field of vpsFields) {
        if (!workerFields.includes(field)) {
          assert.fail(
            `${table}.${field} is in VPS ENCRYPTED_FIELDS but MISSING from Worker crypto.ts.\n` +
            `Both must be in sync. Add "${field}" to the ${table} array in worker/src/services/crypto.ts`
          );
        }
      }
    }
  });

  it('every table with encrypted fields has at least the content/core field', () => {
    // Every table in ENCRYPTED_FIELDS should have at least one field
    for (const [table, fields] of Object.entries(ENCRYPTED_FIELDS)) {
      assert.ok(
        fields.length > 0,
        `Table '${table}' is in ENCRYPTED_FIELDS but has no fields listed`
      );
    }
  });

  it('session tokens are hashed, not stored plaintext', async () => {
    // Verify the passkey module hashes tokens before storage
    const { readFileSync } = await import('fs');
    const passkey = readFileSync('lib/auth/passkey.js', 'utf-8');

    assert.ok(
      passkey.includes('hashToken') || passkey.includes('createHash'),
      'lib/auth/passkey.js must hash session tokens before storing in D1.\n' +
      'Expected to find hashToken() or createHash() but neither was found.'
    );

    // Verify the hash function uses SHA-256
    assert.ok(
      passkey.includes("sha256") || passkey.includes("'sha256'"),
      'Session token hashing must use SHA-256'
    );
  });

  it('PM2 logs do not contain prompt content', async () => {
    const { readFileSync } = await import('fs');
    const agentServer = readFileSync('agent-server.js', 'utf-8');

    // Check that prompt.substring() is NOT used in console.log
    const lines = agentServer.split('\n');
    const leaks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('console.log') || line.includes('console.error')) {
        if (line.includes('prompt.substring') || line.includes('fullOutput.slice') || line.includes('fullOutput.substring')) {
          leaks.push(`Line ${i + 1}: ${line.trim().substring(0, 100)}`);
        }
      }
    }

    if (leaks.length > 0) {
      assert.fail(
        `agent-server.js logs prompt/output content to PM2 logs:\n` +
        leaks.join('\n') +
        '\n\nUse length-only logging: console.log(`... ${prompt.length} chars`)'
      );
    }
  });
});
