import { agent, pipeline } from '@skelm/core'

/**
 * Simple test to verify the pi backend is working with tool execution.
 */
export default pipeline({
  id: 'pi-smoke',
  description: 'Verifies the @skelm/pi backend runs an agent step with bash exec.',
  steps: [
    agent({
      id: 'bash-test',
      backend: 'pi',
      prompt: 'Run `echo hello world` and report the output.',
      permissions: {
        allowedExecutables: ['bash'],
      },
    }),
  ],
})
