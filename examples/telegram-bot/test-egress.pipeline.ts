import { agent, pipeline } from '@skelm/core'

/**
 * Test pipeline for network egress proxy enforcement.
 *
 * This workflow tests network egress enforcement via the gateway's embedded
 * CONNECT proxy. The proxy is configured with a policy that blocks certain
 * hostnames. Agent subprocesses have HTTP_PROXY/HTTPS_PROXY injected, so
 * their outbound connections go through the proxy.
 *
 * NOTE: The pi RPC backend does NOT enforce tool permissions natively.
 * Network egress is enforced at the proxy layer, not the tool layer.
 *
 * Test scenarios:
 * 1. networkEgress: 'deny' - proxy blocks all outbound connections
 * 2. networkEgress: { allowHosts: ['httpbin.org'] } - proxy only allows httpbin.org
 * 3. networkEgress: 'allow' - proxy allows all outbound connections
 *
 * Run with: skelm gateway start
 * Then trigger via: skelm run test-egress.pipeline.ts
 */
export default pipeline({
  id: 'test-egress-proxy',
  name: 'Egress Proxy Test',
  description: 'Test network egress enforcement via embedded proxy',
  steps: [
    // Step 1: Deny all network access
    agent({
      id: 'deny-network',
      backend: 'pi',
      prompt: `You are running in a sandbox with NO network access.
Try to fetch data from http://httpbin.org/get using curl.
Report what happens and the exact error message you receive.`,
      permissions: {
        networkEgress: 'deny',
        allowedExecutables: ['bash'],
      },
    }),
  ],
})
