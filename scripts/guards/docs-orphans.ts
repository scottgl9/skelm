#!/usr/bin/env tsx
// Guard: every authored *.md under docs/ is reachable from the VitePress
// nav/sidebar in docs/.vitepress/config.ts — either directly listed or
// transitively linked from a listed page.
//
// Generated trees (reference/api/) and node_modules/dist are skipped.
// Catches orphans like docs/concepts/system-prompt.md that ship to the site
// but aren't navigable from any menu.

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const DOCS_DIR = join(REPO_ROOT, 'docs')
const CONFIG_FILE = join(DOCS_DIR, '.vitepress/config.ts')

const SKIP_DIRS = new Set(['node_modules', '.vitepress', 'public', 'scripts'])
const SKIP_PREFIXES = ['reference/api/']
// Files that legitimately exist outside the sidebar (e.g. README.md siblings
// that VitePress rewrites to /index via the `rewrites:` config). Keep this
// list short and justified.
const EXEMPT = new Set<string>([
  'README.md',
  'CHANGELOG.md',
  'index.md', // landing page (VitePress home layout)
  // Section indexes — referenced as /section/ in nav, served by rewrites.
  'concepts/README.md',
  'guides/README.md',
  'quickstart/README.md',
  'recipes/README.md',
  'reference/README.md',
  'backends/README.md',
  'contributing/README.md',
])

async function walkMd(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walkMd(full, out)
    } else if (entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function parseSidebarLinks(configSrc: string): Set<string> {
  // Extract every `link: '...'` string literal from the config. Cheaper and
  // less fragile than importing the TS module for a CI guard.
  const links = new Set<string>()
  const re = /link:\s*['"]([^'"]+)['"]/g
  for (;;) {
    const m = re.exec(configSrc)
    if (m === null) break
    const link = m[1]
    if (!link || link.startsWith('http')) continue
    links.add(link)
  }
  return links
}

function sidebarLinkToFile(link: string): string {
  // /quickstart/ -> quickstart/README.md (via rewrites)
  // /concepts/permissions -> concepts/permissions.md
  // /CHANGELOG -> CHANGELOG.md
  const stripped = link.replace(/^\//, '').replace(/\/$/, '')
  if (stripped === '') return 'README.md'
  // Section root like 'concepts'
  if (!stripped.includes('/')) {
    return `${stripped}/README.md`
  }
  return `${stripped}.md`
}

async function extractLinksFrom(file: string): Promise<string[]> {
  const src = await readFile(file, 'utf8')
  const out: string[] = []
  // Match markdown links [text](target)
  const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (;;) {
    const m = re.exec(src)
    if (m === null) break
    const target = m[1].split('#')[0]
    if (!target || target.startsWith('http') || target.startsWith('mailto:')) continue
    out.push(target)
  }
  return out
}

function resolveLink(fromFile: string, target: string): string | null {
  // Returns the absolute path of the linked file under DOCS_DIR, or null if
  // it points outside / can't be resolved as a doc file.
  let resolved: string
  if (target.startsWith('/')) {
    resolved = join(DOCS_DIR, target.replace(/^\//, ''))
  } else {
    resolved = resolve(dirname(fromFile), target)
  }
  // Normalize: /foo -> /foo.md or /foo/README.md
  if (resolved.endsWith('/')) {
    resolved = join(resolved, 'README.md')
  }
  if (!resolved.endsWith('.md')) {
    // Could be a clean-URL link to a page; try .md then /README.md
    const asMd = `${resolved}.md`
    const asIndex = join(resolved, 'README.md')
    return asMd.startsWith(DOCS_DIR) // both candidates live under DOCS_DIR; prefer .md
      ? asMd
      : asIndex
  }
  if (!resolved.startsWith(DOCS_DIR)) return null
  return resolved
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  const allFiles = await walkMd(DOCS_DIR)
  const allRel = allFiles.map((f) => relative(DOCS_DIR, f))

  const configSrc = await readFile(CONFIG_FILE, 'utf8')
  const sidebarLinks = parseSidebarLinks(configSrc)

  // Seed reachable set from sidebar.
  const reachableRel = new Set<string>()
  const queue: string[] = []
  for (const link of sidebarLinks) {
    const rel = sidebarLinkToFile(link)
    const abs = join(DOCS_DIR, rel)
    if (await fileExists(abs)) {
      if (!reachableRel.has(rel)) {
        reachableRel.add(rel)
        queue.push(abs)
      }
    }
  }

  // BFS through markdown links.
  while (queue.length) {
    const cur = queue.shift()
    if (cur === undefined) break
    const links = await extractLinksFrom(cur)
    for (const link of links) {
      // .yaml / .png / etc. — non-markdown assets, not part of the orphan check
      if (
        link.includes('.') &&
        !link.match(/\.md(#|$)/) &&
        !link.endsWith('/') &&
        !link.match(/[^./]$/)
      ) {
        continue
      }
      const resolved = resolveLink(cur, link)
      if (!resolved) continue
      const rel = relative(DOCS_DIR, resolved)
      if (rel.startsWith('..')) continue
      if (reachableRel.has(rel)) continue
      if (await fileExists(resolved)) {
        reachableRel.add(rel)
        queue.push(resolved)
      }
    }
  }

  const orphans = allRel.filter((rel) => {
    if (reachableRel.has(rel)) return false
    if (EXEMPT.has(rel)) return false
    if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) return false
    return true
  })

  if (orphans.length) {
    console.error(
      'docs orphan guard: the following docs are not reachable from .vitepress/config.ts:',
    )
    for (const o of orphans) console.error(`  - docs/${o}`)
    console.error(
      '\nFix: add the page to a sidebar in docs/.vitepress/config.ts, link it from a reachable page, or delete it.',
    )
    process.exit(1)
  }
  console.log(`docs orphan guard: ok (${allRel.length} files, ${reachableRel.size} reachable)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
