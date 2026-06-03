#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  fail('usage: validate-commit-message.mjs <commit-msg-file>')
}

const raw = readFileSync(file, 'utf8')
const lines = raw.split(/\r?\n/)
const meaningful = stripCommentsAndScissors(lines)
const subject = meaningful[0]?.trim() ?? ''

if (subject.length === 0) fail('commit message subject is required')
if (/^(Merge|Revert)\b/.test(subject)) process.exit(0)

const match = /^(feat|fix|refactor|chore|docs|test)(\([^)]+\))?: (.+)$/.exec(subject)
if (match === null) {
  fail('subject must start with feat:, fix:, refactor:, chore:, docs:, or test:')
}

const summary = match[3]?.trim() ?? ''
if (summary.length < 10) {
  fail('subject summary is too short to be descriptive')
}
if (/^(update|changes?|misc|wip|fix|cleanup|work)$/i.test(summary)) {
  fail('subject summary is too generic')
}
if (subject.length > 72) {
  fail('subject must be 72 characters or fewer')
}

const body = meaningful.slice(1)
if (body[0] !== undefined && body[0].trim().length > 0) {
  fail('leave a blank line between the subject and body')
}

for (let i = 0; i < body.length; i++) {
  const line = body[i] ?? ''
  if (line.length >= 80) {
    fail(`body line ${i + 2} must be under 80 characters`)
  }
}

function stripCommentsAndScissors(input) {
  const out = []
  for (const line of input) {
    if (line.startsWith('# ------------------------ >8 ------------------------')) break
    if (line.startsWith('#')) continue
    out.push(line.replace(/\s+$/, ''))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

function fail(message) {
  process.stderr.write(`commit-msg: ${message}\n`)
  process.exit(1)
}
