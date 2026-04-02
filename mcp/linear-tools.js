#!/usr/bin/env node
/**
 * MCP Tools for Linear project management
 *
 * Tools: linearListIssues, linearGetIssue, linearCreateIssue,
 *        linearUpdateIssue, linearSearch, linearAddComment
 *
 * Uses Linear GraphQL API. Requires LINEAR_API_KEY.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const LINEAR_API = 'https://api.linear.app/graphql';

function getApiKey() { return process.env.LINEAR_API_KEY; }
function getTeamId() { return process.env.LINEAR_TEAM_ID; }

// ── GraphQL Helper ───────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const key = getApiKey();
  if (!key) throw new Error('LINEAR_API_KEY not configured');

  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': key,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

// ── State Resolution Cache ───────────────────────────────────────────

let statesCache = null;
let statesCacheTime = 0;

async function resolveState(name) {
  if (!name) return null;
  const now = Date.now();
  if (!statesCache || now - statesCacheTime > 5 * 60 * 1000) {
    const data = await gql(`query { workflowStates { nodes { id name } } }`);
    statesCache = data.workflowStates.nodes;
    statesCacheTime = now;
  }
  const match = statesCache.find(s => s.name.toLowerCase() === name.toLowerCase());
  return match?.id || null;
}

// ── Issue Identifier Resolution ──────────────────────────────────────

async function resolveIssueId(idOrKey) {
  if (!idOrKey) return null;
  // If it looks like a UUID, use directly
  if (idOrKey.match(/^[a-f0-9-]{36}$/)) return idOrKey;
  // If it looks like KEY-123, resolve via search
  const match = idOrKey.match(/^([A-Z]+)-(\d+)$/);
  if (match) {
    const data = await gql(
      `query($filter: IssueFilter) { issues(filter: $filter, first: 1) { nodes { id } } }`,
      { filter: { number: { eq: parseInt(match[2]) } } },
    );
    return data.issues.nodes[0]?.id || null;
  }
  return idOrKey;
}

// ── Formatters ───────────────────────────────────────────────────────

function formatIssue(i) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description?.slice(0, 500),
    state: i.state?.name,
    priority: i.priority,
    assignee: i.assignee?.name,
    project: i.project?.name,
    labels: i.labels?.nodes?.map(l => l.name),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    url: i.url,
  };
}

const ISSUE_FIELDS = `
  id identifier title description state { name } priority
  assignee { name } project { name } labels { nodes { name } }
  createdAt updatedAt url
`;

// ── MCP Server ───────────────────────────────────────────────────────

const server = new Server(
  { name: 'linear-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'linearListIssues',
      description: 'List issues from Linear. Filter by state, assignee, project, or label.',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Filter by state name (e.g. "In Progress", "Todo", "Done")' },
          assignee: { type: 'string', description: 'Filter by assignee name' },
          project: { type: 'string', description: 'Filter by project name' },
          label: { type: 'string', description: 'Filter by label name' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'linearGetIssue',
      description: 'Get details of a specific Linear issue by ID or identifier (e.g. "MYC-42").',
      inputSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Issue UUID or identifier (e.g. MYC-42)' },
        },
        required: ['issueId'],
      },
    },
    {
      name: 'linearCreateIssue',
      description: 'Create a new issue in Linear.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue title' },
          description: { type: 'string', description: 'Issue description (markdown)' },
          state: { type: 'string', description: 'Initial state name (default: "Todo")' },
          priority: { type: 'number', description: '0=none, 1=urgent, 2=high, 3=medium, 4=low' },
          assignee: { type: 'string', description: 'Assignee name' },
          project: { type: 'string', description: 'Project name' },
          labels: { type: 'string', description: 'Comma-separated label names' },
        },
        required: ['title'],
      },
    },
    {
      name: 'linearUpdateIssue',
      description: 'Update an existing Linear issue.',
      inputSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Issue UUID or identifier' },
          title: { type: 'string' },
          description: { type: 'string' },
          state: { type: 'string', description: 'New state name' },
          priority: { type: 'number' },
        },
        required: ['issueId'],
      },
    },
    {
      name: 'linearSearch',
      description: 'Search Linear issues by text query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'linearAddComment',
      description: 'Add a comment to a Linear issue.',
      inputSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Issue UUID or identifier' },
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['issueId', 'body'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!getApiKey()) {
    return { content: [{ type: 'text', text: 'Linear not configured — LINEAR_API_KEY missing.' }], isError: true };
  }

  try {
    switch (name) {
      case 'linearListIssues': {
        const filters = [];
        const teamId = getTeamId();
        if (teamId) filters.push(`team: { id: { eq: "${teamId}" } }`);
        if (args.state) {
          const stateId = await resolveState(args.state);
          if (stateId) filters.push(`state: { id: { eq: "${stateId}" } }`);
        }

        const filterStr = filters.length > 0 ? `filter: { ${filters.join(', ')} }` : '';
        const limit = args.limit || 20;

        const data = await gql(`query {
          issues(${filterStr} first: ${limit}, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`);

        return { content: [{ type: 'text', text: JSON.stringify(data.issues.nodes.map(formatIssue), null, 2) }] };
      }

      case 'linearGetIssue': {
        const id = await resolveIssueId(args.issueId);
        if (!id) return { content: [{ type: 'text', text: `Issue not found: ${args.issueId}` }], isError: true };

        const data = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} comments { nodes { body user { name } createdAt } } } }`, { id });
        const issue = formatIssue(data.issue);
        issue.comments = data.issue.comments?.nodes?.map(c => ({
          body: c.body?.slice(0, 300),
          author: c.user?.name,
          createdAt: c.createdAt,
        }));

        return { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] };
      }

      case 'linearCreateIssue': {
        const input = { title: args.title, teamId: getTeamId() };
        if (args.description) input.description = args.description;
        if (args.priority != null) input.priority = args.priority;
        if (args.state) {
          const stateId = await resolveState(args.state);
          if (stateId) input.stateId = stateId;
        }

        const data = await gql(
          `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
          { input },
        );

        return { content: [{ type: 'text', text: JSON.stringify(formatIssue(data.issueCreate.issue), null, 2) }] };
      }

      case 'linearUpdateIssue': {
        const id = await resolveIssueId(args.issueId);
        if (!id) return { content: [{ type: 'text', text: `Issue not found: ${args.issueId}` }], isError: true };

        const input = {};
        if (args.title) input.title = args.title;
        if (args.description) input.description = args.description;
        if (args.priority != null) input.priority = args.priority;
        if (args.state) {
          const stateId = await resolveState(args.state);
          if (stateId) input.stateId = stateId;
        }

        const data = await gql(
          `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`,
          { id, input },
        );

        return { content: [{ type: 'text', text: JSON.stringify(formatIssue(data.issueUpdate.issue), null, 2) }] };
      }

      case 'linearSearch': {
        const data = await gql(
          `query($query: String!, $first: Int) { searchIssues(term: $query, first: $first) { nodes { ${ISSUE_FIELDS} } } }`,
          { query: args.query, first: args.limit || 10 },
        );

        return { content: [{ type: 'text', text: JSON.stringify(data.searchIssues.nodes.map(formatIssue), null, 2) }] };
      }

      case 'linearAddComment': {
        const id = await resolveIssueId(args.issueId);
        if (!id) return { content: [{ type: 'text', text: `Issue not found: ${args.issueId}` }], isError: true };

        await gql(
          `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
          { input: { issueId: id, body: args.body } },
        );

        return { content: [{ type: 'text', text: `Comment added to ${args.issueId}` }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Linear error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
