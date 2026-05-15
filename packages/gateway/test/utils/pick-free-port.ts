/**
 * Ask the OS for an ephemeral port and release it before returning so the caller
 * can bind to it. Shared across gateway tests that need to spin up a real HTTP
 * server on a known port (e.g. to point a client at `http://127.0.0.1:<port>`).
 *
 * There is an unavoidable TOCTOU window between releasing and re-binding; tests
 * should accept that and retry at a higher level if a flake ever appears.
 */
export async function pickFreePort(): Promise<number> {
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
