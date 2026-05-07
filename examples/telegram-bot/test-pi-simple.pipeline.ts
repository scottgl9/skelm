import { pipeline, agent } from '@skelm/core'

/**
 * Simple test pipeline to verify pi backend is working.
 */
export default pipeline({
  id: 'test-pi-simple',
  name: 'Simple Pi Test',
  description: 'Test pi backend without egress proxy',
  steps: [
    agent({
      id: 'simple-test',
      backend: 'pi',
      prompt: 'Say hello and count to 3.',
    }),
  ],
})
