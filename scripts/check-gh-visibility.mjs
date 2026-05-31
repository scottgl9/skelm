#!/usr/bin/env node
/**
 * Probe each @scottgl9/* GitHub Packages npm package's visibility and, for
 * any that are still `private`, print the per-package settings URL where the
 * visibility can be flipped to public.
 *
 * GitHub does not currently expose a REST endpoint for changing user-scoped
 * package visibility — that one click in the UI is the only path today. This
 * script keeps the post-publish checklist mechanical: run it after every
 * publish, follow each link, click "Change visibility -> Public".
 *
 * Required env: GH_PACKAGES_TOKEN (classic PAT with read:packages).
 */

const TOKEN = process.env.GH_PACKAGES_TOKEN
if (!TOKEN) {
  console.error('error: GH_PACKAGES_TOKEN must be set')
  process.exit(1)
}

const USER = 'scottgl9'
const PACKAGES = [
  'core',
  'cli',
  'gateway',
  'scheduler',
  'integration-sdk',
  'integrations',
  'agentmemory',
  'metrics',
  'opencode',
  'codex',
  'otel',
  'pi',
  'vercel-ai',
  'agent',
  'skelm',
]

async function check(pkg) {
  const res = await fetch(`https://api.github.com/users/${USER}/packages/npm/${pkg}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) {
    return { pkg, error: `${res.status} ${res.statusText}` }
  }
  const body = await res.json()
  return { pkg, visibility: body.visibility, repo: body.repository?.full_name }
}

const results = await Promise.all(PACKAGES.map(check))

const stillPrivate = []
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.pkg.padEnd(15)} ${r.error}`)
    continue
  }
  const tag = r.visibility === 'public' ? 'public ' : 'PRIVATE'
  console.log(`  ${r.pkg.padEnd(15)} ${tag}  (linked: ${r.repo ?? '-'})`)
  if (r.visibility !== 'public') stillPrivate.push(r.pkg)
}

if (stillPrivate.length === 0) {
  console.log('\nall packages public')
  process.exit(0)
}

console.log('\nThe following packages are still PRIVATE.')
console.log('GitHub provides no API to flip user-scoped package visibility — open each')
console.log('URL in a browser, scroll to "Danger Zone", click "Change package visibility",')
console.log('select Public, and confirm by typing the package name:\n')
for (const pkg of stillPrivate) {
  console.log(`  https://github.com/users/${USER}/packages/npm/${pkg}/settings`)
}
process.exit(2)
