import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronTrigger, createIntervalTrigger, createWebhookTrigger } from '../src/builders.js'
import { Scheduler } from '../src/scheduler.js'

describe('Scheduler', () => {
  let mockRunStore: { putRun: ReturnType<typeof vi.fn> }
  let mockPipelineLoader: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockRunStore = {
      putRun: vi.fn().mockResolvedValue(undefined),
    }
    mockPipelineLoader = vi.fn().mockResolvedValue({ id: 'test-pipeline' })
  })

  it('creates a scheduler with default config', () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )
    expect(scheduler).toBeDefined()
  })

  it('registers a cron trigger', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const trigger = createCronTrigger('test-cron', 'pipeline-1', '0 * * * *')
    const registration = await scheduler.register(trigger)

    expect(registration.trigger.id).toBe('test-cron')
    expect(registration.status).toBe('active')
    expect(registration.runCount).toBe(0)
    await scheduler.stop()
  })

  it('marks a cron trigger errored when the expression is invalid', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const trigger = createCronTrigger('bad-cron', 'pipeline-1', 'not a cron expression')
    await scheduler.register(trigger)
    const reg = scheduler.getTrigger('bad-cron')
    expect(reg?.status).toBe('error')
    expect(reg?.lastError).toMatch(/Invalid cron expression/)
    expect(reg?.lastErrorAt).toEqual(expect.any(Number))
    expect(reg?.lastOutcome).toBe('failed')
    errorSpy.mockRestore()
    await scheduler.stop()
  })

  it('marks an interval trigger errored when the interval is invalid', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const trigger = createIntervalTrigger('bad-interval', 'pipeline-1', 0)
    await scheduler.register(trigger)
    const reg = scheduler.getTrigger('bad-interval')

    expect(reg?.status).toBe('error')
    expect(reg?.lastError).toMatch(/Invalid interval/)
    expect(reg?.lastErrorAt).toEqual(expect.any(Number))
    expect(reg?.lastOutcome).toBe('failed')
    await scheduler.stop()
  })

  it('registers an interval trigger', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const trigger = createIntervalTrigger('test-interval', 'pipeline-1', 60000)
    const registration = await scheduler.register(trigger)

    expect(registration.trigger.id).toBe('test-interval')
    expect(registration.trigger.intervalMs).toBe(60000)
    expect(registration.nextRunAt).toEqual(expect.any(Number))
    await scheduler.stop()
  })

  it('lists all triggers', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const cronTrigger = createCronTrigger('cron-1', 'pipeline-1', '*/5 * * * *')
    const intervalTrigger = createIntervalTrigger('interval-1', 'pipeline-1', 300000)

    await scheduler.register(cronTrigger)
    await scheduler.register(intervalTrigger)

    const triggers = scheduler.listTriggers()
    expect(triggers).toHaveLength(2)
    await scheduler.stop()
  })

  it('pauses and resumes a trigger', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const trigger = createIntervalTrigger('test-pause', 'pipeline-1', 60000)
    await scheduler.register(trigger)

    await scheduler.pause('test-pause')
    const paused = scheduler.getTrigger('test-pause')
    expect(paused?.status).toBe('paused')

    await scheduler.resume('test-pause')
    const resumed = scheduler.getTrigger('test-pause')
    expect(resumed?.status).toBe('active')
    await scheduler.stop()
  })

  it('unregisters a trigger', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const trigger = createIntervalTrigger('test-unregister', 'pipeline-1', 60000)
    await scheduler.register(trigger)
    await scheduler.unregister('test-unregister')

    const triggers = scheduler.listTriggers()
    expect(triggers).toHaveLength(0)
  })

  it('starts and stops all triggers', async () => {
    const scheduler = new Scheduler(
      {},
      {
        runStore: mockRunStore,
        pipelineLoader: mockPipelineLoader,
      },
    )

    const trigger = createIntervalTrigger('test-startstop', 'pipeline-1', 60000)
    await scheduler.register(trigger)

    await scheduler.start()
    expect(scheduler).toBeDefined()

    await scheduler.stop()
  })
})

describe('Trigger Builders', () => {
  it('creates a cron trigger with options', () => {
    const trigger = createCronTrigger('cron-1', 'pipeline-1', '0 0 * * *', {
      description: 'Daily at midnight',
      enabled: true,
      dedupe: 'skip',
      overlap: 'wait',
      metadata: { timezone: 'America/Chicago' },
    })

    expect(trigger.type).toBe('cron')
    expect(trigger.schedule).toBe('0 0 * * *')
    expect(trigger.timezone).toBe('America/Chicago')
  })

  it('creates an interval trigger with initial delay', () => {
    const trigger = createIntervalTrigger('interval-1', 'pipeline-1', 60000, {
      description: 'Every minute',
      initialDelayMs: 5000,
    })

    expect(trigger.type).toBe('interval')
    expect(trigger.intervalMs).toBe(60000)
    expect(trigger.initialDelayMs).toBe(5000)
  })

  it('creates a webhook trigger', () => {
    const trigger = createWebhookTrigger('webhook-1', 'pipeline-1', '/webhooks/test', {
      description: 'Test webhook',
      secret: 'test-secret',
      overlap: 'run-concurrent',
      maxConcurrent: 10,
    })

    expect(trigger.type).toBe('webhook')
    expect(trigger.path).toBe('/webhooks/test')
    expect(trigger.secret).toBe('test-secret')
    expect(trigger.overlap).toBe('run-concurrent')
  })
})
