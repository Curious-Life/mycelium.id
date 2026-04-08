#!/usr/bin/env node
/**
 * KMS Backup — Encrypted export/import of all KEKs.
 *
 * Usage:
 *   KMS_BACKUP_KEY=<64-hex> node backup.js export backup.enc
 *   KMS_BACKUP_KEY=<64-hex> node backup.js import backup.enc
 *   KMS_BACKUP_KEY=<64-hex> node backup.js verify backup.enc
 *
 * The backup key is a random 256-bit key stored in 1Password.
 * It is NEVER stored on any server — only provided as env var at backup time.
 */

import { readFileSync, writeFileSync } from 'fs';
import { exportEncrypted, importEncrypted, customerCount, listCustomers } from './key-store.js';
import { logAudit, initAudit } from './audit.js';

const BACKUP_KEY = process.env.KMS_BACKUP_KEY;
const command = process.argv[2];
const filePath = process.argv[3];

if (!command || !['export', 'import', 'verify'].includes(command)) {
  console.log('Usage: KMS_BACKUP_KEY=<hex> node backup.js <export|import|verify> <path>');
  process.exit(1);
}

if (!BACKUP_KEY || BACKUP_KEY.length !== 64) {
  console.error('KMS_BACKUP_KEY must be a 64-character hex string');
  process.exit(1);
}

if (!filePath) {
  console.error('File path required');
  process.exit(1);
}

// Initialize audit (needed for logging)
initAudit();

if (command === 'export') {
  console.log(`Exporting ${customerCount()} KEKs...`);
  const blob = await exportEncrypted(BACKUP_KEY);
  writeFileSync(filePath, blob);
  console.log(`Backup written to ${filePath} (${blob.length} bytes)`);
  logAudit({ customerId: 'system', action: 'backup', details: { customers: customerCount(), size: blob.length } });
}

if (command === 'import') {
  const blob = readFileSync(filePath);
  console.log(`Importing from ${filePath} (${blob.length} bytes)...`);
  const restored = await importEncrypted(blob, BACKUP_KEY);
  console.log(`Restored ${restored} KEKs (total now: ${customerCount()})`);
  logAudit({ customerId: 'system', action: 'restore', details: { restored, total: customerCount() } });
}

if (command === 'verify') {
  try {
    const blob = readFileSync(filePath);
    // Try to decrypt without importing (just verify it decrypts)
    const { webcrypto } = await import('crypto');
    const { subtle } = webcrypto;

    if (blob[0] !== 1) throw new Error(`Unknown backup version: ${blob[0]}`);
    const iv = blob.subarray(1, 13);
    const ct = blob.subarray(13);
    const keyBytes = Buffer.from(BACKUP_KEY, 'hex');
    const backupKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, backupKey, ct);
    const entries = JSON.parse(Buffer.from(pt).toString('utf-8'));

    console.log(`Backup verified: ${entries.length} KEKs`);
    for (const e of entries) {
      console.log(`  ${e.customerId} (created: ${e.createdAt})`);
    }
    // Zero decrypted data
    Buffer.from(pt).fill(0);
  } catch (err) {
    console.error(`Backup verification FAILED: ${err.message}`);
    process.exit(1);
  }
}
