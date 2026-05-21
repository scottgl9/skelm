import type { ExitCode } from '../exit-codes.js'

/**
 * Standard I/O streams handed to every CLI subcommand. Kept in this leaf
 * module so subcommand files can depend on the shapes without importing
 * `main.ts` (which would close a CLI-wide import cycle since main.ts
 * imports every subcommand).
 */
export interface MainIO {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  stdin: NodeJS.ReadableStream
}

/** Uniform subcommand return shape: the exit code the process should use. */
export interface MainResult {
  exitCode: ExitCode
}
