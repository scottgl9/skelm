#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../reference/openapi.yaml', import.meta.url))
const dest = fileURLToPath(new URL('../public/openapi.yaml', import.meta.url))

await mkdir(dirname(dest), { recursive: true })
await copyFile(src, dest)
console.log(`copied ${src} -> ${dest}`)
