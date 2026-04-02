/**
 * GitHub OAuth - Handle GitHub authentication for repo access
 */

import fs from 'fs/promises';
import path from 'path';

// Read lazily — bootstrap-secrets populates process.env before first use
const AGENTS_DIR = process.env.AGENTS_DIR || '/home/claude/agents';
const TOKEN_FILE = path.join(AGENTS_DIR, '.github-token');

// Scopes we need for repo access
const SCOPES = ['repo', 'read:user', 'read:org'];

/**
 * Get the GitHub OAuth authorization URL
 */
export function getAuthUrl(redirectUri) {
  if (!process.env.GITHUB_CLIENT_ID) {
    throw new Error('process.env.GITHUB_CLIENT_ID not configured');
  }

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state: generateState()
  });

  return `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(code) {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    throw new Error('GitHub OAuth not configured');
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  return data.access_token;
}

/**
 * Save the GitHub token to disk
 */
export async function saveToken(token) {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, token, { mode: 0o600 });
}

/**
 * Get the stored GitHub token
 */
export async function getToken() {
  try {
    return await fs.readFile(TOKEN_FILE, 'utf-8');
  } catch {
    return process.env.GITHUB_TOKEN || null;
  }
}

/**
 * Check if GitHub is connected
 */
export async function isConnected() {
  const token = await getToken();
  if (!token) return { connected: false };

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      return { connected: false };
    }

    const user = await response.json();
    return {
      connected: true,
      user: {
        login: user.login,
        name: user.name,
        avatar: user.avatar_url
      }
    };
  } catch {
    return { connected: false };
  }
}

/**
 * List user's repositories
 */
export async function listRepos(page = 1, perPage = 100) {
  const token = await getToken();
  if (!token) {
    throw new Error('GitHub not connected');
  }

  const response = await fetch(
    `https://api.github.com/user/repos?page=${page}&per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    }
  );

  if (!response.ok) {
    throw new Error('Failed to fetch repositories');
  }

  const repos = await response.json();
  return repos.map(repo => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    url: repo.html_url,
    cloneUrl: repo.clone_url,
    description: repo.description,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at
  }));
}

/**
 * Search user's repositories
 * Filters from the full list since GitHub search API doesn't support @me
 */
export async function searchRepos(query, perPage = 30) {
  const token = await getToken();
  if (!token) {
    throw new Error('GitHub not connected');
  }

  // Fetch all user repos and filter locally
  // This is more reliable than using the search API with user qualifiers
  const allRepos = await listRepos(1, 100);
  const lowerQuery = query.toLowerCase();

  return allRepos
    .filter(repo =>
      repo.name.toLowerCase().includes(lowerQuery) ||
      repo.fullName.toLowerCase().includes(lowerQuery) ||
      (repo.description && repo.description.toLowerCase().includes(lowerQuery))
    )
    .slice(0, perPage);
}

/**
 * Disconnect GitHub (remove token)
 */
export async function disconnect() {
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {
    // File might not exist
  }
}

/**
 * Generate a random state for CSRF protection
 */
function generateState() {
  return Math.random().toString(36).substring(2, 15);
}

export default {
  getAuthUrl,
  exchangeCodeForToken,
  saveToken,
  getToken,
  isConnected,
  listRepos,
  searchRepos,
  disconnect
};
