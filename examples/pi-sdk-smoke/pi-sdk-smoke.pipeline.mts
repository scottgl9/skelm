import { agent, pipeline } from '@skelm/core'

/**
 * Simple test to verify pi-sdk backend is working with tool execution.
 */
export default pipeline({
  id: 'pi-sdk-smoke',
  description: 'Verifies the @skelm/pi SDK backend runs an agent step with bash exec.',
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
