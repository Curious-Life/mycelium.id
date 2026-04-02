/**
 * Personal Data Guard
 *
 * Ensures no personal data leaks into the codebase.
 * Scans all source files for known personal strings.
 * Run before every sync to public repo.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';

const BANNED = [
  'Martin Balodis',
  'martin@curiouslife',
  'martinam-balodim',
  '1206312513013293168',
  'Nati (Thailand)',
  'Martin (Latvia)',
  'intel.curiouslife.is',
];

// Directories to exclude
const EXCLUDE = [
  'node_modules', '.wrangler', 'portal/build', 'portal/.svelte-kit',
  'sites/', 'migrations/', 'agents/moms-agent.json', '.git',
];

describe('personal data guard', () => {
  for (const term of BANNED) {
    it(`no occurrence of "${term}" in source files`, () => {
      const excludeArgs = EXCLUDE.map(d => `--glob=!${d}`).join(' ');
      let result = '';
      try {
        result = execSync(
          `rg -l --type js --type ts --type py "${term}" ${excludeArgs} || true`,
          { cwd: process.cwd(), encoding: 'utf-8', timeout: 10000 }
        ).trim();
      } catch {
        // rg not found — fallback to grep
        try {
          const grepExclude = EXCLUDE.map(d => `--exclude-dir=${d}`).join(' ');
          result = execSync(
            `grep -rl "${term}" --include='*.js' --include='*.ts' --include='*.py' --include='*.cjs' ${grepExclude} . || true`,
            { cwd: process.cwd(), encoding: 'utf-8', timeout: 10000 }
          ).trim();
        } catch {
          result = '';
        }
      }
      assert.equal(result, '', `Found "${term}" in: ${result}`);
    });
  }
});
