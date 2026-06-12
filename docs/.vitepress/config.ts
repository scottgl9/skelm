import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

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
  // Dead-link check is on for authored docs. The TypeDoc-generated tree under
  // /reference/api/ is exempt — typedoc emits a few stale `../README` and
  // `_media/LICENSE` links we can't fix without patching the generator.
  ignoreDeadLinks: [/^\.{1,2}\/(\.\.\/)*(README|_media\/LICENSE)/],

  head: [
    [
      'script',
      {
        src: 'https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js',
        defer: '',
      },
    ],
  ],

  rewrites: {
    'concepts/README.md': 'concepts/index.md',
    'guides/README.md': 'guides/index.md',
    'quickstart/README.md': 'quickstart/index.md',
    'recipes/README.md': 'recipes/index.md',
    'reference/README.md': 'reference/index.md',
    'backends/README.md': 'backends/index.md',
    'contributing/README.md': 'contributing/index.md',
  },

  themeConfig: {
    logo: '/logo-icon.svg',
    siteTitle: 'skelm',

    nav: [
      { text: 'Guide', link: '/quickstart/' },
      { text: 'Concepts', link: '/concepts/' },
      { text: 'Recipes', link: '/recipes/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Contributing', link: '/contributing/' },
      { text: 'Changelog', link: '/CHANGELOG' },
      { text: 'GitHub', link: 'https://github.com/scottgl9/skelm' },
    ],

    sidebar: {
      '/quickstart/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Quickstart', link: '/quickstart/' },
            { text: 'Add an agent step', link: '/quickstart/add-agent' },
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Overview', link: '/concepts/' },
            { text: 'Permissions', link: '/concepts/permissions' },
            { text: 'Orchestration', link: '/concepts/orchestration' },
            { text: 'Persistent Workflows', link: '/concepts/persistent-workflows' },
            { text: 'Coding Agents', link: '/concepts/coding-agents' },
            { text: 'System Prompt', link: '/concepts/system-prompt' },
            { text: 'Registries', link: '/concepts/registries' },
          ],
        },
      ],
      '/recipes/': [
        {
          text: 'Recipes',
          items: [
            { text: 'All Recipes', link: '/recipes/' },
            { text: 'Telegram Persistent Workflow', link: '/recipes/telegram-persistent-workflow' },
            { text: 'Chat-UI Persistent Workflow', link: '/recipes/chatui-persistent-workflow' },
            { text: 'Matrix Persistent Agent', link: '/recipes/matrix-persistent-agent' },
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
            { text: 'Building Workflows', link: '/guides/building-workflows' },
            { text: 'Writing a Backend', link: '/guides/writing-a-backend' },
            { text: 'Writing a Plugin', link: '/guides/writing-a-plugin' },
            { text: 'Writing a Custom Integration', link: '/guides/writing-a-custom-integration' },
            { text: 'Testing Workflows', link: '/guides/testing-workflows' },
            { text: 'External Scripts', link: '/guides/external-scripts' },
          ],
        },
        {
          text: 'Operating the gateway',
          items: [
            { text: 'Gateway', link: '/guides/gateway' },
            { text: 'Dashboard', link: '/guides/dashboard' },
            { text: 'Memory', link: '/guides/memory' },
            { text: 'Triggers', link: '/guides/triggers' },
            { text: 'ACP Sessions', link: '/guides/acp-sessions' },
            { text: 'MCP Servers', link: '/guides/mcp-servers' },
            { text: 'Agentmemory', link: '/guides/agentmemory' },
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
            { text: 'WorkflowGraph', link: '/reference/workflow-graph' },
            { text: 'Config', link: '/reference/config' },
            { text: 'Environment Variables', link: '/reference/environment-variables' },
            { text: 'Permissions', link: '/reference/permissions' },
            { text: 'Pipeline Authoring', link: '/reference/pipeline-authoring' },
            { text: 'Agent Step', link: '/reference/agent-step' },
            { text: 'Gateway', link: '/reference/gateway' },
            { text: 'Workflow Packages', link: '/reference/workflow-packages' },
            { text: 'OpenAPI', link: '/reference/openapi' },
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
            { text: 'skelm agent', link: '/backends/skelm-agent' },
            { text: 'Pi', link: '/backends/pi' },
            { text: 'Opencode', link: '/backends/opencode' },
            { text: 'Codex', link: '/backends/codex' },
            { text: 'ACP Backends', link: '/backends/acp-backends' },
            { text: 'Vercel AI', link: '/backends/vercel-ai' },
          ],
        },
      ],
      '/contributing/': [
        {
          text: 'Contributing',
          items: [
            { text: 'Overview', link: '/contributing/' },
            { text: 'Publishing', link: '/contributing/PUBLISHING' },
            {
              text: 'Contributing guide ↗',
              link: 'https://github.com/scottgl9/skelm/blob/main/.github/CONTRIBUTING.md',
            },
            {
              text: 'Security policy ↗',
              link: 'https://github.com/scottgl9/skelm/blob/main/.github/SECURITY.md',
            },
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
            { text: 'Contributing', link: '/contributing/' },
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
