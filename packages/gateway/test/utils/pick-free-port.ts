/**
 * Ask the OS for an ephemeral port and release it before returning so the caller
 * can bind to it. Shared across gateway tests that need to spin up a real HTTP
 * server on a known port (e.g. to point a client at `http://127.0.0.1:<port>`).
 *
 * There is an unavoidable TOCTOU window between releasing this socket and the
 * caller re-binding. CI runs ~145 vitest files in parallel, so the race
 * occasionally fires (a sibling test grabs the same ephemeral port before we
 * return). The retry loop here re-picks N times and re-verifies each
 * candidate with a fresh bind-and-close immediately before returning, which
 * collapses the race window to ~microseconds — small enough that a
 * MaxListeners-warning storm in CI is not enough to lose. The long-term fix
 * is to let the gateway accept `httpPort: 0` and expose the bound port back;
 * this helper is a stopgap.
 */
const DEFAULT_RETRIES = 5

export async function pickFreePort(retries = DEFAULT_RETRIES): Promise<number> {
  let lastError: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const candidate = await acquireEphemeralPort()
      // Verify the port is still free with a second bind. If it isn't (because
      // a sibling picked it between our close and now), loop and pick again.
      if (await isPortBindable(candidate)) return candidate
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `pickFreePort: exhausted ${retries} retries${lastError !== undefined ? ` (last error: ${String(lastError)})` : ''}`,
  )
}

async function acquireEphemeralPort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('port pick failed'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

async function isPortBindable(port: number): Promise<boolean> {
  const { createServer } = await import('node:net')
  return new Promise((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true))
    })
  })
}
