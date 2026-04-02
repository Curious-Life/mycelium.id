/**
 * Agent Manager - PM2 process lifecycle management
 * Each agent runs the existing server.js with different PORT and RESEARCH_DIR
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Agent server lives in the same directory (mycelium/)
const AGENT_SERVER = path.join(__dirname, 'agent-server.js');
const SERVER_CWD = __dirname;

/**
 * Get PM2 process name for an agent (for dynamically spawned agents)
 */
function getProcessName(slug) {
  return `agent-${slug}`;
}

/**
 * Find PM2 process by slug (checks both naming conventions)
 * Dynamically spawned agents use "agent-{slug}" prefix
 * Built-in agents may use just the slug (e.g., "research-agent")
 * Returns the process object if found, null otherwise
 */
function findProcess(slug) {
  const processes = getPm2List();

  // Try prefixed name first (dynamically spawned agents)
  const prefixedName = `agent-${slug}`;
  let process = processes.find(p => p.name === prefixedName);
  if (process) return process;

  // Fall back to exact slug match (built-in agents like "research-agent")
  process = processes.find(p => p.name === slug);
  return process || null;
}

/**
 * Check if PM2 is available
 */
function checkPm2() {
  try {
    execSync('pm2 --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get PM2 process list
 */
function getPm2List() {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf-8' });
    return JSON.parse(output);
  } catch {
    return [];
  }
}

/**
 * Check if agent process is running
 */
export function isAgentRunning(slug) {
  const process = findProcess(slug);
  return process && process.pm2_env.status === 'online';
}

/**
 * Get agent process status
 */
export function getAgentStatus(slug) {
  const process = findProcess(slug);

  if (!process) {
    return { running: false, status: 'stopped' };
  }

  return {
    running: process.pm2_env.status === 'online',
    status: process.pm2_env.status,
    uptime: process.pm2_env.pm_uptime,
    restarts: process.pm2_env.restart_time,
    memory: process.monit?.memory,
    cpu: process.monit?.cpu
  };
}

/**
 * Start an agent process
 */
export async function startAgent(agent) {
  if (!checkPm2()) {
    throw new Error('PM2 is not installed. Run: npm install -g pm2');
  }

  // Check if already running
  if (isAgentRunning(agent.slug)) {
    return { success: true, message: 'Agent already running' };
  }

  // Check if process exists in PM2 (stopped but registered)
  const existing = findProcess(agent.slug);
  if (existing) {
    // Restart the existing PM2 process (preserves ecosystem config name)
    const command = `pm2 restart ${existing.name}`;
    return new Promise((resolve, reject) => {
      const pm2 = spawn('sh', ['-c', command], { stdio: 'pipe' });
      let output = '';
      pm2.stdout.on('data', data => { output += data; });
      pm2.stderr.on('data', data => { output += data; });
      pm2.on('close', code => {
        if (code === 0) {
          resolve({ success: true, message: `Agent ${agent.slug} restarted` });
        } else {
          reject(new Error(`Failed to restart agent: ${output}`));
        }
      });
      pm2.on('error', reject);
    });
  }

  // New agent: start fresh with PM2
  const processName = getProcessName(agent.slug);
  const envVars = [
    `PORT=${agent.port}`,
    `AGENT_DIR=${agent.repoPath}`,
    `AGENT_SLUG=${agent.slug}`,
    `MODEL=${agent.config?.model || 'sonnet'}`,
    `NODE_ENV=production`
  ].join(' ');

  const command = `${envVars} pm2 start ${AGENT_SERVER} --name ${processName} --cwd ${SERVER_CWD} --interpreter node --interpreter-args="--experimental-modules"`;

  return new Promise((resolve, reject) => {
    const pm2 = spawn('sh', ['-c', command], {
      stdio: 'pipe'
    });

    let output = '';
    pm2.stdout.on('data', data => { output += data; });
    pm2.stderr.on('data', data => { output += data; });

    pm2.on('close', code => {
      if (code === 0) {
        resolve({ success: true, message: `Agent ${agent.slug} started on port ${agent.port}` });
      } else {
        reject(new Error(`Failed to start agent: ${output}`));
      }
    });

    pm2.on('error', reject);
  });
}

/**
 * Stop an agent process
 */
export async function stopAgent(slug) {
  const process = findProcess(slug);

  if (!process) {
    return { success: true, message: 'Agent not running' };
  }

  const processName = process.name;

  return new Promise((resolve, reject) => {
    const pm2 = spawn('pm2', ['stop', processName], { stdio: 'pipe' });

    let output = '';
    pm2.stdout.on('data', data => { output += data; });
    pm2.stderr.on('data', data => { output += data; });

    pm2.on('close', code => {
      if (code === 0) {
        resolve({ success: true, message: `Agent ${slug} stopped` });
      } else {
        reject(new Error(`Failed to stop agent: ${output}`));
      }
    });

    pm2.on('error', reject);
  });
}

/**
 * Restart an agent process
 */
export async function restartAgent(slug) {
  const process = findProcess(slug);

  if (!process) {
    throw new Error(`Agent ${slug} not found in PM2`);
  }

  const processName = process.name;

  return new Promise((resolve, reject) => {
    const pm2 = spawn('pm2', ['restart', processName], { stdio: 'pipe' });

    let output = '';
    pm2.stdout.on('data', data => { output += data; });
    pm2.stderr.on('data', data => { output += data; });

    pm2.on('close', code => {
      if (code === 0) {
        resolve({ success: true, message: `Agent ${slug} restarted` });
      } else {
        reject(new Error(`Failed to restart agent: ${output}`));
      }
    });

    pm2.on('error', reject);
  });
}

/**
 * Delete an agent process from PM2
 */
export async function deleteAgentProcess(slug) {
  const process = findProcess(slug);
  // Use found process name or fall back to prefixed name
  const processName = process?.name || getProcessName(slug);

  return new Promise((resolve, reject) => {
    const pm2 = spawn('pm2', ['delete', processName], { stdio: 'pipe' });

    let output = '';
    pm2.stdout.on('data', data => { output += data; });
    pm2.stderr.on('data', data => { output += data; });

    pm2.on('close', code => {
      // PM2 delete returns 0 even if process doesn't exist
      resolve({ success: true, message: `Agent ${slug} removed from PM2` });
    });

    pm2.on('error', reject);
  });
}

/**
 * Get logs for an agent
 */
export async function getAgentLogs(slug, lines = 100) {
  const process = findProcess(slug);
  // Use found process name or fall back to prefixed name
  const processName = process?.name || getProcessName(slug);

  return new Promise((resolve, reject) => {
    const pm2 = spawn('pm2', ['logs', processName, '--nostream', '--lines', lines.toString()], {
      stdio: 'pipe'
    });

    let output = '';
    pm2.stdout.on('data', data => { output += data; });
    pm2.stderr.on('data', data => { output += data; });

    pm2.on('close', () => {
      resolve(output);
    });

    pm2.on('error', reject);
  });
}

/**
 * Save PM2 process list (for auto-restart on reboot)
 */
export async function savePm2List() {
  return new Promise((resolve, reject) => {
    const pm2 = spawn('pm2', ['save'], { stdio: 'pipe' });

    pm2.on('close', code => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error('Failed to save PM2 list'));
      }
    });

    pm2.on('error', reject);
  });
}

export default {
  isAgentRunning,
  getAgentStatus,
  startAgent,
  stopAgent,
  restartAgent,
  deleteAgentProcess,
  getAgentLogs,
  savePm2List
};
