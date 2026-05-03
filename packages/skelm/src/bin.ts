#!/usr/bin/env node
import { main } from '@skelm/cli'

const result = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
})
process.exit(result.exitCode)
