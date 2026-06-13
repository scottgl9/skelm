import { GetSecretValueCommand, ResourceNotFoundException } from '@aws-sdk/client-secrets-manager'
import { describe, expect, it, vi } from 'vitest'
import {
  AwsSecretsManagerError,
  AwsSecretsManagerResolver,
  type SecretsManagerSendClient,
} from '../../src/secrets/aws-secrets-manager-driver.js'

const VALUE = 'sk-the-actual-secret-value'

function stubClient(
  impl: (command: GetSecretValueCommand) => Promise<{ SecretString?: string }>,
): SecretsManagerSendClient & { sendMock: ReturnType<typeof vi.fn> } {
  const sendMock = vi.fn(impl)
  return { send: sendMock as unknown as SecretsManagerSendClient['send'], sendMock }
}

describe('AwsSecretsManagerResolver — GetSecretValue', () => {
  it('returns the SecretString on a hit and uses the prefixed SecretId', async () => {
    const client = stubClient(async () => ({ SecretString: VALUE }))
    const r = new AwsSecretsManagerResolver({ client, prefix: 'skelm/' })
    expect(await r.resolve('OPENAI_KEY')).toBe(VALUE)
    const cmd = client.sendMock.mock.calls[0][0] as GetSecretValueCommand
    expect(cmd).toBeInstanceOf(GetSecretValueCommand)
    expect(cmd.input.SecretId).toBe('skelm/OPENAI_KEY')
  })

  it('returns undefined when the secret does not exist (ResourceNotFound)', async () => {
    const client = stubClient(async () => {
      throw new ResourceNotFoundException({ message: 'Secrets Manager cannot find', $metadata: {} })
    })
    const r = new AwsSecretsManagerResolver({ client })
    expect(await r.resolve('MISSING')).toBeUndefined()
  })

  it('treats a non-SDK error named ResourceNotFoundException as not-found', async () => {
    const client = stubClient(async () => {
      const e = new Error('x')
      e.name = 'ResourceNotFoundException'
      throw e
    })
    const r = new AwsSecretsManagerResolver({ client })
    expect(await r.resolve('MISSING')).toBeUndefined()
  })

  it('throws a typed error on any other failure', async () => {
    const client = stubClient(async () => {
      const e = new Error('access denied')
      e.name = 'AccessDeniedException'
      throw e
    })
    const r = new AwsSecretsManagerResolver({ client })
    await expect(r.resolve('OPENAI_KEY')).rejects.toBeInstanceOf(AwsSecretsManagerError)
  })

  it('NEVER includes the secret value in the error message', async () => {
    // Error path carrying a message that itself contains the value — the
    // driver must reduce to the AWS error name only.
    const client = stubClient(async () => {
      const e = new Error(`internal error leaked ${VALUE}`)
      e.name = 'InternalServiceErrorException'
      throw e
    })
    const r = new AwsSecretsManagerResolver({ client })
    const err = (await r.resolve('OPENAI_KEY').catch((e) => e)) as AwsSecretsManagerError
    expect(err).toBeInstanceOf(AwsSecretsManagerError)
    expect(err.message).not.toContain(VALUE)
    expect(err.message).toContain('OPENAI_KEY')
    expect(err.message).toContain('InternalServiceErrorException')
  })

  it('never writes the value to console', async () => {
    const logs: string[] = []
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' '))),
      vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' '))),
    ]
    try {
      await new AwsSecretsManagerResolver({
        client: stubClient(async () => ({ SecretString: VALUE })),
      }).resolve('OPENAI_KEY')
      await new AwsSecretsManagerResolver({
        client: stubClient(async () => {
          const e = new Error(`boom ${VALUE}`)
          e.name = 'ThrottlingException'
          throw e
        }),
      })
        .resolve('OPENAI_KEY')
        .catch(() => {})
    } finally {
      for (const s of spies) s.mockRestore()
    }
    expect(logs.join('\n')).not.toContain(VALUE)
  })

  it('serves a cached value within the TTL without a second send', async () => {
    const client = stubClient(async () => ({ SecretString: VALUE }))
    const r = new AwsSecretsManagerResolver({ client, cacheTtlMs: 60_000 })
    expect(await r.resolve('OPENAI_KEY')).toBe(VALUE)
    expect(await r.resolve('OPENAI_KEY')).toBe(VALUE)
    expect(client.sendMock.mock.calls).toHaveLength(1)
  })
})
