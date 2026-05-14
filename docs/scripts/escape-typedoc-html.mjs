#!/usr/bin/env node
// Escape stray `<word>` placeholders in TypeDoc-generated markdown so the
// VitePress / Vue template compiler doesn't treat them as unclosed HTML tags.
// Operates outside fenced code blocks and inline code spans, and only on
// patterns that look like prose placeholders (e.g. `<stateDir>`, `<token>`).

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = new URL('../reference/api/', import.meta.url).pathname

/** @param {string} src */
function escapePlaceholders(src) {
  const lines = src.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    lines[i] = escapeOutsideInlineCode(line)
  }
  return lines.join('\n')
}

const HTML_TAGS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'select',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'svg',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
  'center',
  'big',
  'tt',
  'font',
  'strike',
])

/** @param {string} line */
function escapeOutsideInlineCode(line) {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '`') {
      const close = line.indexOf('`', i + 1)
      if (close === -1) {
        out += line.slice(i)
        break
      }
      out += line.slice(i, close + 1)
      i = close + 1
      continue
    }
    if (ch === '<') {
      const m = /^<([a-zA-Z_][a-zA-Z0-9_-]*)>/.exec(line.slice(i))
      if (m && !HTML_TAGS.has(m[1].toLowerCase())) {
        out += `&lt;${m[1]}&gt;`
        i += m[0].length
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/** @param {string} dir */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(p)
    } else if (entry.isFile() && p.endsWith('.md')) {
      const src = await readFile(p, 'utf8')
      const out = escapePlaceholders(src)
      if (out !== src) await writeFile(p, out)
    }
  }
}

try {
  await stat(ROOT)
} catch {
  console.error(`[escape-typedoc-html] ${ROOT} does not exist; run typedoc first.`)
  process.exit(1)
}

await walk(ROOT)
