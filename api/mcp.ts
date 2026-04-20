import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';

interface GitHubError { status?: number; message?: string; }

function githubError(err: unknown): string {
  const e = err as GitHubError;
  if (e?.status === 401) return 'Error: GitHub token invalid. Update GITHUB_TOKEN in Vercel env vars.';
  if (e?.status === 403) return 'Error: Insufficient permissions. Check token scopes (needs repo).';
  if (e?.status === 404) return 'Error: Not found. Check owner/repo/id values.';
  return `GitHub API error: ${e?.message || String(err)}`;
}

function truncate(text: string, limit = 40000): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n⚠️ Truncated. Use filters to narrow results.';
}

function buildServer(octokit: Octokit, defaultOwner: string): McpServer {
  const server = new McpServer({ name: 'github-mcp-vercel', version: '1.0.0' });
  const ownerSchema = z.string().default(defaultOwner).describe(`GitHub username or org (default: "${defaultOwner}")`);
  const repoSchema = z.string().min(1).describe('Repository name');
  const perPageSchema = z.number().int().min(1).max(100).default(20).describe('Results per page');

  server.registerTool('github_list_repos', {
    title: 'List GitHub Repositories',
    description: 'List repositories for a GitHub user or organisation.',
    inputSchema: z.object({ owner: ownerSchema, type: z.enum(['all','owner','member','public','private']).default('owner'), sort: z.enum(['created','updated','pushed','full_name']).default('updated'), per_page: perPageSchema, page: z.number().int().min(1).default(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, type, sort, per_page, page }) => {
    try {
      const { data } = await octokit.repos.listForUser({ username: owner, type, sort, per_page, page });
      const lines = data.map(r => `### ${r.name}\n**Visibility:** ${r.private ? '🔒 Private' : '🌐 Public'} · **Stars:** ⭐ ${r.stargazers_count} · **Pushed:** ${r.pushed_at?.slice(0,10) || 'never'}\n${r.description || ''}\n${r.html_url}`);
      return { content: [{ type: 'text', text: truncate(`## ${owner}'s Repositories\n\n${lines.join('\n\n')}`) }], structuredContent: data };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_get_repo', {
    title: 'Get Repository Details',
    description: 'Get detailed information about a specific GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, repo }) => {
    try {
      const { data: r } = await octokit.repos.get({ owner, repo });
      const text = `## ${r.full_name}\n**Description:** ${r.description || '_none_'}\n**Visibility:** ${r.private ? '🔒 Private' : '🌐 Public'}\n**Default Branch:** \`${r.default_branch}\`\n**Stars:** ⭐ ${r.stargazers_count} · **Forks:** 🍴 ${r.forks_count}\n**Open Issues:** ${r.open_issues_count}\n**Language:** ${r.language || '_not detected_'}\n**URL:** ${r.html_url}`;
      return { content: [{ type: 'text', text }], structuredContent: r };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_list_issues', {
    title: 'List Issues',
    description: 'List issues in a GitHub repository with optional filters.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, state: z.enum(['open','closed','all']).default('open'), labels: z.string().optional(), per_page: perPageSchema, page: z.number().int().min(1).default(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, repo, state, labels, per_page, page }) => {
    try {
      const { data } = await octokit.issues.listForRepo({ owner, repo, state, per_page, page, ...(labels ? { labels } : {}) });
      const issues = data.filter(i => !i.pull_request);
      const lines = issues.map(i => `**#${i.number}** ${i.title}\nState: ${i.state} · Created: ${i.created_at.slice(0,10)}\n${i.html_url}`);
      return { content: [{ type: 'text', text: truncate(`## Issues — ${owner}/${repo}\n\n${lines.join('\n\n') || 'No issues found.'}`) }], structuredContent: issues };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_create_issue', {
    title: 'Create Issue',
    description: 'Create a new issue in a GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, title: z.string().min(1), body: z.string().optional(), labels: z.string().optional(), assignees: z.string().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ owner, repo, title, body, labels, assignees }) => {
    try {
      const { data } = await octokit.issues.create({ owner, repo, title, ...(body ? { body } : {}), ...(labels ? { labels: labels.split(',').map(l => l.trim()) } : {}), ...(assignees ? { assignees: assignees.split(',').map(a => a.trim()) } : {}) });
      return { content: [{ type: 'text', text: `✅ Created issue **#${data.number}**: ${data.title}\n${data.html_url}` }], structuredContent: { number: data.number, title: data.title, url: data.html_url } };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_list_prs', {
    title: 'List Pull Requests',
    description: 'List pull requests in a GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, state: z.enum(['open','closed','all']).default('open'), per_page: perPageSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, repo, state, per_page }) => {
    try {
      const { data } = await octokit.pulls.list({ owner, repo, state, per_page });
      const lines = data.map(pr => `**#${pr.number}** ${pr.title}\n${pr.head.ref} → ${pr.base.ref} · By: @${pr.user?.login}\n${pr.html_url}`);
      return { content: [{ type: 'text', text: `## Pull Requests — ${owner}/${repo}\n\n${lines.join('\n\n') || 'No PRs found.'}` }], structuredContent: data };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_create_pr', {
    title: 'Create Pull Request',
    description: 'Create a new pull request in a GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, title: z.string().min(1), head: z.string().min(1), base: z.string().min(1).default('main'), body: z.string().optional(), draft: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ owner, repo, title, head, base, body, draft }) => {
    try {
      const { data } = await octokit.pulls.create({ owner, repo, title, head, base, draft, ...(body ? { body } : {}) });
      return { content: [{ type: 'text', text: `✅ Created PR **#${data.number}**: ${data.title}\n${data.html_url}` }], structuredContent: { number: data.number, title: data.title, url: data.html_url } };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_get_file', {
    title: 'Get File Contents',
    description: 'Read the contents of a file from a GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, path: z.string().min(1), ref: z.string().optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, repo, path, ref }) => {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) });
      if (Array.isArray(data)) return { content: [{ type: 'text', text: `"${path}" is a directory. Use a specific file path.` }] };
      if (!('content' in data)) return { content: [{ type: 'text', text: 'Could not read file content.' }] };
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      return { content: [{ type: 'text', text: truncate(`## ${path}\n**SHA:** \`${data.sha}\`\n\n\`\`\`\n${content}\n\`\`\``) }], structuredContent: { path, sha: data.sha, content } };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_create_or_update_file', {
    title: 'Create or Update File',
    description: 'Create or update a file in a GitHub repository. Provide sha when updating an existing file.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, path: z.string().min(1), content: z.string(), message: z.string().min(1), branch: z.string().default('main'), sha: z.string().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, repo, path, content, message, branch, sha }) => {
    try {
      const { data } = await octokit.repos.createOrUpdateFileContents({ owner, repo, path, message, branch, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
      return { content: [{ type: 'text', text: `✅ ${sha ? 'Updated' : 'Created'} \`${path}\` on \`${branch}\`\n**Commit:** \`${data.commit.sha?.slice(0,7)}\`` }], structuredContent: { path, branch, commitSha: data.commit.sha } };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_list_commits', {
    title: 'List Commits',
    description: 'List recent commits in a GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, branch: z.string().optional(), per_page: perPageSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ owner, repo, branch, per_page }) => {
    try {
      const { data } = await octokit.repos.listCommits({ owner, repo, per_page, ...(branch ? { sha: branch } : {}) });
      const lines = data.map(c => `\`${c.sha.slice(0,7)}\` **${c.commit.message.split('\n')[0]}**\nBy ${c.commit.author?.name || 'unknown'} on ${c.commit.author?.date?.slice(0,10)}`);
      return { content: [{ type: 'text', text: `## Commits — ${owner}/${repo}\n\n${lines.join('\n\n')}` }], structuredContent: data };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_create_branch', {
    title: 'Create Branch',
    description: 'Create a new branch in a GitHub repository.',
    inputSchema: z.object({ owner: ownerSchema, repo: repoSchema, branch: z.string().min(1), from_branch: z.string().default('main') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ owner, repo, branch, from_branch }) => {
    try {
      const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${from_branch}` });
      await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.object.sha });
      return { content: [{ type: 'text', text: `✅ Created branch \`${branch}\` from \`${from_branch}\`` }], structuredContent: { branch, from_branch } };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  server.registerTool('github_search_repos', {
    title: 'Search Repositories',
    description: 'Search GitHub repositories by keyword, language, or topic.',
    inputSchema: z.object({ query: z.string().min(1), per_page: z.number().int().min(1).max(30).default(10) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, per_page }) => {
    try {
      const { data } = await octokit.search.repos({ q: query, per_page });
      const lines = data.items.map(r => `**${r.full_name}** ⭐ ${r.stargazers_count}\n${r.description || '_no description_'}\n${r.html_url}`);
      return { content: [{ type: 'text', text: `## Search: "${query}" (${data.total_count.toLocaleString()} total)\n\n${lines.join('\n\n')}` }], structuredContent: data.items };
    } catch (err) { return { content: [{ type: 'text', text: githubError(err) }] }; }
  });

  return server;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    return res.json({ status: 'ok', server: 'github-mcp-vercel', version: '1.0.0', authenticated: !!process.env['GITHUB_TOKEN'], defaultOwner: process.env['GITHUB_OWNER'] || 'GvAiSuperAdmin' });
  }
  const token = process.env['GITHUB_TOKEN'];
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not set in Vercel env vars.' });
  const octokit = new Octokit({ auth: token });
  const defaultOwner = process.env['GITHUB_OWNER'] || 'GvAiSuperAdmin';
  const server = buildServer(octokit, defaultOwner);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req as unknown as import('http').IncomingMessage, res as unknown as import('http').ServerResponse, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
}
