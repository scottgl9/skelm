import { defineConfig } from 'vitepress'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const typedocSidebarPath = fileURLToPath(
  new URL('../reference/api/typedoc-sidebar.json', import.meta.url),
)
const typedocSidebar = existsSync(typedocSidebarPath)
  ? (JSON.parse(readFileSync(typedocSidebarPath, 'utf8')) as unknown[])
  : []

export default defineConfig({
  title: 'skelm',
  description: 'TypeScript framework for secure, agentic, long-running workflows',
  base: '/skelm/',

  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'skelm',

    nav: [
      { text: 'Guide', link: '/quickstart/' },
      { text: 'Concepts', link: '/concepts/' },
      { text: 'Recipes', link: '/recipes/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Contributing', link: '/contributing/CONTRIBUTING' },
      { text: 'Changelog', link: '/CHANGELOG' },
      { text: 'GitHub', link: 'https://github.com/scottgl9/skelm' },
    ],

    sidebar: {
      '/quickstart/': [
        {
          text: 'Getting Started',
          items: [{ text: 'Quickstart', link: '/quickstart/' }],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Overview', link: '/concepts/' },
            { text: 'Permissions', link: '/concepts/permissions' },
            { text: 'Coding Agents', link: '/concepts/coding-agents' },
            { text: 'Registries', link: '/concepts/registries' },
          ],
        },
      ],
      '/recipes/': [
        {
          text: 'Recipes',
          items: [
            { text: 'All Recipes', link: '/recipes/' },
            { text: 'Coding Agent on Chat', link: '/recipes/coding-agent-on-chat' },
            { text: 'Ticket to PR', link: '/recipes/ticket-to-pr' },
            { text: 'Email Triage', link: '/recipes/email-triage' },
            { text: 'HTTP Enrichment', link: '/recipes/http-enrichment' },
            { text: 'OpenTelemetry', link: '/recipes/otel-exporter' },
          ],
        },
      ],
      '/guides/': [
        {
          text: 'Guides',
          items: [{ text: 'Overview', link: '/guides/' }],
        },
        {
          text: 'Authoring',
          items: [
            { text: 'Writing a Backend', link: '/guides/writing-a-backend' },
            { text: 'Writing a Plugin', link: '/guides/writing-a-plugin' },
            { text: 'Testing Workflows', link: '/guides/testing-workflows' },
          ],
        },
        {
          text: 'Operating the gateway',
          items: [
            { text: 'Gateway', link: '/guides/gateway' },
            { text: 'Triggers', link: '/guides/triggers' },
            { text: 'ACP Sessions', link: '/guides/acp-sessions' },
            { text: 'MCP Servers', link: '/guides/mcp-servers' },
          ],
        },
        {
          text: 'Security & compliance',
          items: [
            { text: 'Approvals', link: '/guides/approvals' },
            { text: 'Secrets', link: '/guides/secrets' },
            { text: 'Audit', link: '/guides/audit' },
            { text: 'Production Hardening', link: '/guides/production-hardening' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'API (generated)', link: '/reference/api' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'HTTP', link: '/reference/http' },
            { text: 'Config', link: '/reference/config' },
            { text: 'Permissions', link: '/reference/permissions' },
            { text: 'Pipeline Authoring', link: '/reference/pipeline-authoring' },
            { text: 'Agent Step', link: '/reference/agent-step' },
            { text: 'Gateway', link: '/reference/gateway' },
          ],
        },
        {
          text: 'Generated API',
          collapsed: true,
          items: typedocSidebar as { text: string; link: string }[],
        },
      ],
      '/backends/': [
        {
          text: 'Backends',
          items: [
            { text: 'Overview', link: '/backends/' },
            { text: 'Pi', link: '/backends/pi' },
            { text: 'Opencode', link: '/backends/opencode' },
            { text: 'ACP Backends', link: '/backends/acp-backends' },
            { text: 'Vercel AI', link: '/backends/vercel-ai' },
          ],
        },
      ],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [
            { text: 'Contributing guide', link: '/contributing/CONTRIBUTING' },
            { text: 'Security policy', link: '/contributing/SECURITY' },
            { text: 'Publishing', link: '/contributing/PUBLISHING' },
          ],
        },
      ],
      '/': [
        {
          text: 'Documentation',
          items: [
            { text: 'Quickstart', link: '/quickstart/' },
            { text: 'Concepts', link: '/concepts/' },
            { text: 'Recipes', link: '/recipes/' },
            { text: 'Guides', link: '/guides/' },
            { text: 'Reference', link: '/reference/' },
            { text: 'Backends', link: '/backends/' },
            { text: 'Contributing', link: '/contributing/CONTRIBUTING' },
            { text: 'Changelog', link: '/CHANGELOG' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/scottgl9/skelm' }],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Scott Glover',
    },
  },
})
