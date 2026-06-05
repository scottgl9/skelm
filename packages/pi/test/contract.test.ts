/**
 * Backend-contract suite for `@skelm/pi`.
 */

import { runBackendContract } from '@skelm/core/testing/contract'
import { vi } from 'vitest'

vi.mock('../src/sdk-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/sdk-client.js')>('../src/sdk-client.js')
  const MockPiSdkClient = vi.fn().mockImplementation(function () {
    return {
      prompt: vi.fn().mockResolvedValue({
        text: 'ok',
        stopReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    }
  })
  return { ...actual, PiSdkClient: MockPiSdkClient }
})

import { createPiSdkBackend } from '../src/sdk-backend.js'

runBackendContract(
  () =>
    createPiSdkBackend({
      id: 'pi',
      provider: 'openai',
      model: 'test-model',
      baseUrl: 'http://test.invalid/v1',
      apiKey: 'test-key',
    }),
  {
    name: 'pi',
  },
)
