/** Minimal IO surface for stdout writes — compatible with MainIO and DescribeCommandIO. */
interface StdoutIO {
  stdout: NodeJS.WritableStream
}

/** Pretty-print a value as 2-space-indented JSON followed by a newline. */
export function writeJsonOutput(io: StdoutIO, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}
