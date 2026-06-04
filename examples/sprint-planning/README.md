# sprint-planning

Weekly cron-triggered sprint planning with LLM-assisted story selection.

Demonstrates: cron trigger, `agent()` with structured output schema, data flowing from `code()` steps into an LLM prompt.

## What it does

1. **Fetch backlog** (`code`) — retrieves stories from Jira (simulated with sample data; swap in the real Jira SDK).
2. **Calculate capacity** (`code`) — computes available story points from team size and sprint duration (70% efficiency factor).
3. **Select stories** (`agent`) — an LLM reviews the backlog and capacity, selects the optimal set of stories (prioritising critical/high), and explains its reasoning. This is the step that beats a plain cron script.
4. **Create sprint** (`code`) — simulates Jira sprint creation with the selected stories.
5. **Notify team** (`code`) — simulates a Slack notification with the sprint summary.

## Run

```bash
OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=unused OPENAI_MODEL=qwen35 \
  skelm run sprint-planning.pipeline.mts \
  --input '{"projectKey":"ENG","teamSize":5,"sprintDuration":14}'
```

With a custom point target:

```bash
OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=unused OPENAI_MODEL=qwen35 \
  skelm run sprint-planning.pipeline.mts \
  --input '{"projectKey":"ENG","teamSize":4,"sprintDuration":14,"targetPoints":35}'
```

## Cron trigger

When the gateway is running the pipeline fires every Friday at 2 PM:

```bash
skelm gateway start --foreground
# Pipeline is registered automatically from the triggers declaration.
skelm schedule list
```

To fire immediately for testing:

```bash
skelm schedule fire sprint-planning --input '{"projectKey":"ENG","teamSize":5,"sprintDuration":14}'
```

## Adapting for production

- Replace `SAMPLE_BACKLOG` in the `fetch-backlog` step with a real Jira `issueSearch` call.
- Replace the `create-sprint` step with `jira.sprint.createSprint(...)`.
- Replace the `notify-team` step with `slack.chat.postMessage(...)`.
- Add `state` to track velocity across sprints for more accurate capacity planning.
