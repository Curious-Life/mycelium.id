#!/usr/bin/env node
/**
 * Backfill Energy Ledger — Parse historical Claude session JSONL files
 * into the energy ledger format (agents/.shared/energy/<date>.jsonl).
 *
 * Scans all CLAUDE_CONFIG_DIR paths for session files, extracts token usage
 * from assistant messages, and writes energy records grouped by date.
 *
 * Usage:
 *   node scripts/backfill-energy.js
 *   node scripts/backfill-energy.js --dry-run   # show counts without writing
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const AGENTS_ROOT = process.env.AGENTS_ROOT || path.join(os.homedir(), 'agents');
const ENERGY_DIR = path.join(AGENTS_ROOT, '.shared', 'energy');
const DRY_RUN = process.argv.includes('--dry-run');

// Map config dirs to agent IDs by scanning the projects directory name
// e.g., /home/claude/.claude/projects/-home-claude-agents-alpha-repo/ → alpha
function extractAgentFromPath(filePath) {
  const match = filePath.match(/-agents-([a-z]+)-/);
  return match ? match[1] : 'unknown';
}

// Map model IDs to short names
function shortModel(model) {
  if (!model) return 'unknown';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return model;
}

// Config directories to scan
const CONFIG_DIRS = [
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.claude-alpha'),
  path.join(os.homedir(), '.claude-beta'),
  path.join(os.homedir(), '.claude-delta'),
];

// Map config dir to subscription label
function configLabel(configDir) {
  const base = path.basename(configDir);
  if (base === '.claude') return 'shared';
  return base.replace('.claude-', '');
}

async function findJsonlFiles(configDir) {
  const projectsDir = path.join(configDir, 'projects');
  const files = [];

  async function walk(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith('.jsonl')) {
          files.push(full);
        }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  await walk(projectsDir);
  return files;
}

async function parseSessionFile(filePath, configDir) {
  const records = [];
  const agent = extractAgentFromPath(filePath);
  const config = configLabel(configDir);

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  // Accumulate usage per session (sum all assistant messages)
  let sessionId = null;
  let sessionRecords = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);

      // Grab session ID
      if (data.session_id) sessionId = data.session_id;

      // Extract usage from assistant messages
      if (data.type === 'assistant' && data.message?.usage) {
        const u = data.message.usage;
        const ts = data.timestamp || data.message?.created_at;
        if (!ts) continue;

        sessionRecords.push({
          ts,
          agent,
          process: 'session', // can't determine chat/think from JSONL
          model: shortModel(data.message.model || data.model),
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
          costUsd: null,
          sessionId: sessionId,
          durationMs: null,
          configDir: config,
          trigger: 'backfill',
        });
      }
    } catch { /* skip bad lines */ }
  }

  return sessionRecords;
}

async function writeEnergyRecords(records) {
  // Group by date
  const byDate = {};
  for (const r of records) {
    const date = r.ts.split('T')[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  }

  await fs.mkdir(ENERGY_DIR, { recursive: true });

  let totalWritten = 0;
  for (const [date, dateRecords] of Object.entries(byDate).sort()) {
    const file = path.join(ENERGY_DIR, `${date}.jsonl`);
    const lines = dateRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.appendFile(file, lines);
    totalWritten += dateRecords.length;
    console.log(`  ${date}: ${dateRecords.length} records`);
  }

  return totalWritten;
}

async function main() {
  console.log(`[backfill-energy] Scanning session files...`);
  if (DRY_RUN) console.log('  (dry run — no files will be written)\n');

  let allRecords = [];
  let totalFiles = 0;

  for (const configDir of CONFIG_DIRS) {
    const files = await findJsonlFiles(configDir);
    if (files.length === 0) continue;

    console.log(`\n${configDir}: ${files.length} session files`);
    totalFiles += files.length;

    for (const file of files) {
      try {
        const records = await parseSessionFile(file, configDir);
        allRecords.push(...records);
      } catch (err) {
        // Skip files that can't be parsed
      }
    }
  }

  console.log(`\n[backfill-energy] Parsed ${allRecords.length} energy records from ${totalFiles} files`);

  // Summary by agent
  const byAgent = {};
  for (const r of allRecords) {
    if (!byAgent[r.agent]) byAgent[r.agent] = { records: 0, inputTokens: 0, outputTokens: 0 };
    byAgent[r.agent].records++;
    byAgent[r.agent].inputTokens += r.inputTokens;
    byAgent[r.agent].outputTokens += r.outputTokens;
  }

  console.log('\nPer-agent summary:');
  for (const [agent, data] of Object.entries(byAgent).sort((a, b) => b[1].records - a[1].records)) {
    const totalTok = data.inputTokens + data.outputTokens;
    console.log(`  ${agent}: ${data.records} records, ${(totalTok / 1_000_000).toFixed(1)}M tokens`);
  }

  // Date range
  if (allRecords.length > 0) {
    const dates = allRecords.map(r => r.ts).sort();
    console.log(`\nDate range: ${dates[0].split('T')[0]} → ${dates[dates.length - 1].split('T')[0]}`);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No files written.');
  } else {
    console.log('\nWriting energy ledger files...');
    const written = await writeEnergyRecords(allRecords);
    console.log(`\n[backfill-energy] Done — ${written} records written to ${ENERGY_DIR}/`);
  }
}

main().catch(err => {
  console.error('[backfill-energy] Fatal:', err.message);
  process.exit(1);
});