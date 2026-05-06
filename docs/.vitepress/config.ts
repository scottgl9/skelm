import { defineConfig } from 'vitepress'

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
      { text: 'Recipes', link: '/recipes/' },
      { text: 'Reference', link: '/reference/api' },
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
          items: [
            { text: 'Testing Workflows', link: '/guides/testing-workflows' },
            { text: 'Writing a Backend', link: '/guides/writing-a-backend' },
            { text: 'Writing a Plugin', link: '/guides/writing-a-plugin' },
            { text: 'ACP Sessions', link: '/guides/acp-sessions' },
            { text: 'Approvals', link: '/guides/approvals' },
            { text: 'Audit', link: '/guides/audit' },
            { text: 'Gateway', link: '/guides/gateway' },
            { text: 'MCP Servers', link: '/guides/mcp-servers' },
            { text: 'Secrets', link: '/guides/secrets' },
            { text: 'Triggers', link: '/guides/triggers' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'API (Core)', link: '/reference/api' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'HTTP', link: '/reference/http' },
          ],
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
          ],
        },
      ],
      '/': [
        {
          text: 'Documentation',
          items: [
            { text: 'Quickstart', link: '/quickstart/' },
            { text: 'Recipes', link: '/recipes/' },
            { text: 'Guides', link: '/guides/testing-workflows' },
            { text: 'Reference', link: '/reference/api' },
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
