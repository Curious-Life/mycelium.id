/**
 * Repo Manager - Git operations with GitHub token authentication
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import githubOAuth from './github-oauth.js';

/**
 * Get the GitHub token (from OAuth or env)
 */
async function getGitHubToken() {
  return await githubOAuth.getToken();
}

/**
 * Transform GitHub URL to include auth token
 * https://github.com/user/repo -> https://oauth2:TOKEN@github.com/user/repo
 */
async function getAuthenticatedUrl(repoUrl) {
  const token = await getGitHubToken();
  if (!token) {
    throw new Error('GitHub not connected. Please connect your GitHub account first.');
  }

  const url = new URL(repoUrl);
  if (url.hostname !== 'github.com') {
    throw new Error('Only GitHub URLs are supported');
  }

  return `https://oauth2:${token}@github.com${url.pathname}`;
}

/**
 * Run a git command and return promise
 */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });

    let stdout = '';
    let stderr = '';

    git.stdout.on('data', data => { stdout += data; });
    git.stderr.on('data', data => { stderr += data; });

    git.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Git error: ${stderr || stdout}`));
      }
    });

    git.on('error', reject);
  });
}

/**
 * Clone a repository
 */
export async function cloneRepo({ repoUrl, targetPath, branch = 'main', agentName = 'MYA Agent' }) {
  // Ensure parent directory exists
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  // Check if already cloned
  try {
    await fs.access(path.join(targetPath, '.git'));
    console.log(`Repo already exists at ${targetPath}, pulling instead`);
    return pullRepo(targetPath, branch);
  } catch {
    // Not cloned yet, proceed
  }

  const authUrl = await getAuthenticatedUrl(repoUrl);

  // Try to clone with specified branch, fall back to default branch if not found
  try {
    await runGit(['clone', '--branch', branch, '--single-branch', authUrl, targetPath], process.cwd());
  } catch (error) {
    // If branch not found, clone without branch flag (uses default branch)
    if (error.message.includes('not found') || error.message.includes('Remote branch')) {
      console.log(`Branch '${branch}' not found, cloning default branch instead`);
      await runGit(['clone', authUrl, targetPath], process.cwd());
    } else {
      throw error;
    }
  }

  // Configure git user for commits
  await runGit(['config', 'user.name', agentName], targetPath);
  await runGit(['config', 'user.email', 'agent@mycelium.local'], targetPath);

  return { success: true, path: targetPath };
}

/**
 * Pull latest changes
 */
export async function pullRepo(repoPath, branch = 'main') {
  await runGit(['fetch', 'origin'], repoPath);
  await runGit(['checkout', branch], repoPath);
  await runGit(['pull', 'origin', branch], repoPath);

  return { success: true };
}

/**
 * Get current branch
 */
export async function getCurrentBranch(repoPath) {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
}

/**
 * Get latest commit info
 */
export async function getLatestCommit(repoPath) {
  const hash = await runGit(['rev-parse', 'HEAD'], repoPath);
  const message = await runGit(['log', '-1', '--pretty=%B'], repoPath);
  const date = await runGit(['log', '-1', '--pretty=%ci'], repoPath);

  return { hash: hash.slice(0, 7), message: message.trim(), date };
}

/**
 * List branches
 */
export async function listBranches(repoUrl) {
  const authUrl = await getAuthenticatedUrl(repoUrl);
  const output = await runGit(['ls-remote', '--heads', authUrl], process.cwd());

  return output
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [, ref] = line.split('\t');
      return ref.replace('refs/heads/', '');
    });
}

/**
 * Delete repo directory
 */
export async function deleteRepo(repoPath) {
  await fs.rm(repoPath, { recursive: true, force: true });
  return { success: true };
}

/**
 * Commit and push changes
 */
export async function commitAndPush(repoPath, message, files = ['.']) {
  // Stage files
  for (const file of files) {
    await runGit(['add', file], repoPath);
  }

  // Check if there are changes to commit
  try {
    const status = await runGit(['status', '--porcelain'], repoPath);
    if (!status.trim()) {
      return { success: true, message: 'No changes to commit' };
    }
  } catch {
    // Continue anyway
  }

  // Commit
  await runGit(['commit', '-m', message], repoPath);

  // Push
  const branch = await getCurrentBranch(repoPath);
  await runGit(['push', 'origin', branch], repoPath);

  return { success: true, message: 'Changes committed and pushed' };
}

/**
 * Get repo status
 */
export async function getStatus(repoPath) {
  const status = await runGit(['status', '--porcelain'], repoPath);
  const branch = await getCurrentBranch(repoPath);

  return {
    branch,
    hasChanges: status.trim().length > 0,
    changes: status.trim().split('\n').filter(Boolean)
  };
}

export default {
  cloneRepo,
  pullRepo,
  getCurrentBranch,
  getLatestCommit,
  listBranches,
  deleteRepo,
  commitAndPush,
  getStatus
};
