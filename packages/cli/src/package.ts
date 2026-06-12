import { isAbsolute, resolve } from 'node:path'
import { EXIT, type ExitCode } from './exit-codes.js'
import { fetchHttp, httpError, requireGateway } from './internal/gateway-client.js'
import type { MainIO } from './internal/io.js'
import { writeJsonOutput } from './internal/output.js'
import { renderTable } from './table.js'

export interface PackageCommandArgs {
  subcommand: 'install' | 'list' | 'info' | 'remove' | 'update'
  /** Source for install (dir/.tgz) or package name for info/remove/update. */
  target?: string
  /** Version filter for remove. */
  version?: string
  json?: boolean
}

export interface PackageCommandResult {
  exitCode: ExitCode
}

interface InstalledPackage {
  name: string
  version: string
  description?: string
  lock: { resolved?: string; integrity?: string } | null
}

interface PackageInfo {
  name: string
  manifest?: { description?: string; skelm?: { workflows?: { id: string }[] } }
  versions: string[]
  integrity?: string
  lock: { resolved?: string; integrity?: string; installedAt?: string } | null
}

export async function packageCommand(
  args: PackageCommandArgs,
  io: MainIO,
): Promise<PackageCommandResult> {
  const client = await requireGateway(io)
  if (client === null) return { exitCode: EXIT.CLI_ERROR }
  const base = client.discovery.url

  switch (args.subcommand) {
    case 'install': {
      if (args.target === undefined) {
        io.stderr.write('error: skelm package install requires a source (directory or .tgz)\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      // A local source path is resolved to an absolute path so the gateway,
      // which may run from a different cwd, reads the right location.
      const source = isAbsolute(args.target) ? args.target : resolve(process.cwd(), args.target)
      const res = await fetchHttp(
        `${base}/v1/packages/install`,
        { method: 'POST', headers: client.headers, body: JSON.stringify({ source }) },
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
      const body = (await res.json()) as {
        installed: { name: string; version: string; integrity: string }
      }
      if (args.json === true) {
        writeJsonOutput(io, body)
      } else {
        io.stdout.write(
          `installed ${body.installed.name}@${body.installed.version} (${body.installed.integrity})\n`,
        )
      }
      return { exitCode: EXIT.OK }
    }

    case 'list': {
      const res = await fetchHttp(`${base}/v1/packages`, { headers: client.headers }, io)
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
      const body = (await res.json()) as { packages: InstalledPackage[] }
      if (args.json === true) {
        writeJsonOutput(io, body.packages)
        return { exitCode: EXIT.OK }
      }
      if (body.packages.length === 0) {
        io.stdout.write('No packages installed.\n')
        return { exitCode: EXIT.OK }
      }
      const rows = [
        ['NAME', 'VERSION', 'DESCRIPTION'],
        ...body.packages.map((p) => [p.name, p.version, p.description ?? '']),
      ]
      io.stdout.write(`${renderTable(rows)}\n`)
      return { exitCode: EXIT.OK }
    }

    case 'info': {
      if (args.target === undefined) {
        io.stderr.write('error: skelm package info requires a package name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const info = await fetchPackageInfo(base, client.headers, args.target, io)
      if (info === 'error') return { exitCode: EXIT.CLI_ERROR }
      if (info === 'not-found') {
        io.stderr.write(`error: package not installed: ${args.target}\n`)
        return { exitCode: EXIT.CLI_ERROR }
      }
      if (args.json === true) {
        writeJsonOutput(io, info)
        return { exitCode: EXIT.OK }
      }
      const lines = [
        `name: ${info.name}`,
        `versions: ${info.versions.join(', ') || '(none installed)'}`,
        ...(info.manifest?.description !== undefined
          ? [`description: ${info.manifest.description}`]
          : []),
        ...(info.integrity !== undefined ? [`integrity: ${info.integrity}`] : []),
        ...(info.lock?.resolved !== undefined ? [`source: ${info.lock.resolved}`] : []),
      ]
      const workflows = info.manifest?.skelm?.workflows ?? []
      if (workflows.length > 0) lines.push(`workflows: ${workflows.map((w) => w.id).join(', ')}`)
      io.stdout.write(`${lines.join('\n')}\n`)
      return { exitCode: EXIT.OK }
    }

    case 'remove': {
      if (args.target === undefined) {
        io.stderr.write('error: skelm package remove requires a package name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      const query = args.version !== undefined ? `?version=${encodeURIComponent(args.version)}` : ''
      const res = await fetchHttp(
        `${base}/v1/packages/${encodeURIComponent(args.target)}${query}`,
        { method: 'DELETE', headers: client.headers },
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
      const body = (await res.json()) as { name: string; version?: string }
      if (args.json === true) {
        writeJsonOutput(io, body)
      } else {
        io.stdout.write(
          `removed ${body.name}${body.version !== undefined ? `@${body.version}` : ''}\n`,
        )
      }
      return { exitCode: EXIT.OK }
    }

    case 'update': {
      if (args.target === undefined) {
        io.stderr.write('error: skelm package update requires a package name\n')
        return { exitCode: EXIT.CLI_ERROR }
      }
      // Reinstall from the source recorded in the lockfile. Only local
      // sources are supported, mirroring the install surface.
      const info = await fetchPackageInfo(base, client.headers, args.target, io)
      if (info === 'error') return { exitCode: EXIT.CLI_ERROR }
      if (info === 'not-found' || info.lock?.resolved === undefined) {
        io.stderr.write(
          `error: cannot update ${args.target}: no recorded install source in the lockfile\n`,
        )
        return { exitCode: EXIT.CLI_ERROR }
      }
      const res = await fetchHttp(
        `${base}/v1/packages/install`,
        {
          method: 'POST',
          headers: client.headers,
          body: JSON.stringify({ source: info.lock.resolved }),
        },
        io,
      )
      if (res === null) return { exitCode: EXIT.CLI_ERROR }
      if (!res.ok) return (await httpError(res, io)) as { exitCode: ExitCode }
      const body = (await res.json()) as {
        installed: { name: string; version: string; integrity: string }
      }
      if (args.json === true) {
        writeJsonOutput(io, body)
      } else {
        io.stdout.write(`updated ${body.installed.name}@${body.installed.version}\n`)
      }
      return { exitCode: EXIT.OK }
    }
  }
}

async function fetchPackageInfo(
  base: string,
  headers: Record<string, string>,
  name: string,
  io: MainIO,
): Promise<PackageInfo | 'not-found' | 'error'> {
  const res = await fetchHttp(`${base}/v1/packages/${encodeURIComponent(name)}`, { headers }, io)
  if (res === null) return 'error'
  if (res.status === 404) return 'not-found'
  if (!res.ok) {
    await httpError(res, io)
    return 'error'
  }
  return (await res.json()) as PackageInfo
}
