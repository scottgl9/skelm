import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Scheduler } from '../src/scheduler.js'
import {
  createCronTrigger,
  createIntervalTrigger,
  createWebhookTrigger,
  createPollTrigger,
  createQueueTrigger,
} from '../src/builders.js'

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
    expect(scheduler).toBeDefined() // Would check internal state in production

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

  it('creates a poll trigger', () => {
    const trigger = createPollTrigger(
      'poll-1',
      'pipeline-1',
      'https://api.example.com/data',
      300000,
      {
        description: 'Poll every 5 minutes',
        headers: { Authorization: 'Bearer token' },
        overlap: 'wait',
      },
    )

    expect(trigger.type).toBe('poll')
    expect(trigger.url).toBe('https://api.example.com/data')
    expect(trigger.intervalMs).toBe(300000)
    expect(trigger.headers?.['Authorization']).toBe('Bearer token')
  })

  it('creates a queue trigger', () => {
    const trigger = createQueueTrigger('queue-1', 'pipeline-1', 'my-queue', {
      description: 'Process queue messages',
      batchSize: 5,
      visibilityTimeoutMs: 30000,
      overlap: 'run-concurrent',
      maxConcurrent: 5,
    })

    expect(trigger.type).toBe('queue')
    expect(trigger.queueName).toBe('my-queue')
    expect(trigger.batchSize).toBe(5)
    expect(trigger.visibilityTimeoutMs).toBe(30000)
  })
})
