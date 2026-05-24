import { Gateway, type GatewayOptions } from '../../src/index.js'
import { pickFreePort } from './pick-free-port.js'

/**
 * Construct + start a Gateway with retry on EADDRINUSE. CI runs many
 * vitest files in parallel; an OS-assigned ephemeral port can be grabbed
 * by a sibling worker between pickFreePort()'s close and Gateway.start()'s
 * bind. A couple of retries collapse the race window to ~microseconds.
 */
export async function bootGatewayWithRetry(
  optionsFactory: (port: number) => GatewayOptions,
  retries = 5,
): Promise<{ gw: Gateway; base: string; port: number }> {
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    const port = await pickFreePort()
    const gw = new Gateway(optionsFactory(port))
    try {
      await gw.start()
      return { gw, base: `http://127.0.0.1:${port}`, port }
    } catch (err) {
      lastErr = err
      try {
        await gw.stop()
      } catch {
        // ignore
      }
      if (!/EADDRINUSE/.test(String((err as Error)?.message ?? err))) throw err
    }
  }
  throw new Error(`bootGatewayWithRetry: exhausted ${retries} retries (${String(lastErr)})`)
}
