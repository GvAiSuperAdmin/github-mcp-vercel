# 🐙 GitHub MCP Server for Vercel

Gives Cowork full GitHub access via a cloud URL. Deploy in one click.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/GvAiSuperAdmin/github-mcp-vercel&env=GITHUB_TOKEN,GITHUB_OWNER)

## Tools (11 total)
- `github_list_repos` `github_get_repo` `github_list_issues` `github_create_issue`
- `github_list_prs` `github_create_pr` `github_get_file` `github_create_or_update_file`
- `github_list_commits` `github_create_branch` `github_search_repos`

## Setup
1. Get GitHub PAT at github.com/settings/tokens/new (tick `repo`)
2. Deploy to Vercel — add env vars: `GITHUB_TOKEN` + `GITHUB_OWNER=GvAiSuperAdmin`
3. Add `https://your-app.vercel.app/mcp` to Cowork MCP settings
