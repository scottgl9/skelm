import { agent, pipeline } from '@skelm/core'

/**
 * Simple test to verify pi-sdk backend is working with tool execution.
 */
export default pipeline({
  id: 'test-pi-sdk-simple',
  name: 'Simple Pi SDK Test',
  description: 'Test pi-sdk backend with bash tool',
  steps: [
    agent({
      id: 'bash-test',
      backend: 'pi-sdk',
      prompt: 'Run `echo hello world` and report the output.',
      permissions: {
        allowedExecutables: ['bash'],
      },
    }),
  ],
})
