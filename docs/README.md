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
│   ├── config.ts
│   ├── theme/
│   └── public/          # Static assets (logo, images)
├── quickstart/          # Getting started guide
├── concepts/            # Core concepts
├── guides/              # How-to guides
├── recipes/             # Complete examples
├── reference/           # API and CLI reference
├── backends/            # Backend provider docs
└── index.md             # Home page
```

## Adding Content

- **New concept page**: Add `.md` file to `concepts/` and update `config.ts` sidebar
- **New recipe**: Add `.md` file to `recipes/` and update `config.ts` sidebar
- **New guide**: Add `.md` file to `guides/` and update `config.ts` sidebar
- **New reference**: Add `.md` file to `reference/` and update `config.ts` sidebar

## Deployment

Documentation is automatically deployed to GitHub Pages when changes are pushed to `main` in the `docs/` directory. See `.github/workflows/docs.yml`.

The site will be available at: `https://scottgl9.github.io/skelm/`
