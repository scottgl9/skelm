# skelm Documentation

This directory contains the documentation website for skelm, built with VitePress.

## Development

```bash
# Install dependencies
cd docs
pnpm install

# Start dev server
pnpm docs:dev

# Build for production
pnpm docs:build

# Preview production build
pnpm docs:preview
```

## Structure

```
docs/
├── .vitepress/          # VitePress config and theme
│   ├── config.ts        # site config + sidebar (loads typedoc-sidebar.json)
│   ├── theme/
│   └── public/          # static assets (logo, images)
├── quickstart/          # getting started guide
├── concepts/            # core concepts (permissions, agents, registries)
├── guides/              # how-to guides, grouped by purpose
├── recipes/             # complete worked examples
├── reference/           # CLI, HTTP, config, permissions, etc.
│   └── api/             # generated TypeDoc per-package reference (gitignored)
├── backends/            # backend-specific docs (pi, opencode, vercel-ai, …)
├── contributing/        # CONTRIBUTING.md, SECURITY.md, PUBLISHING.md
├── skill/               # Claude Code skill pack ('skelm' skill)
├── scripts/             # build helpers (escape-typedoc-html.mjs)
├── typedoc.json         # TypeDoc configuration
├── CHANGELOG.md         # release history
└── index.md             # home page
```

## Adding Content

- **New concept page**: add `.md` to `concepts/` and update `config.ts` sidebar
- **New recipe**: add `.md` to `recipes/` and update `config.ts` sidebar
- **New guide**: add `.md` to `guides/` and update `config.ts` sidebar
- **New reference page**: add `.md` to `reference/` and update `config.ts` sidebar
- **New public export**: add a TSDoc comment in `packages/<pkg>/src/index.ts` —
  TypeDoc picks it up automatically next `docs:build`
- **New backend**: add `.md` to `backends/`, list it in `backends/README.md` and `config.ts`

## Deployment

Documentation is automatically deployed to GitHub Pages when changes are pushed to `main` in the `docs/` directory. See `.github/workflows/docs.yml`.

The site will be available at: `https://scottgl9.github.io/skelm/`
