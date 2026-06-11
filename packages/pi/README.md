# @skelm/pi

> Pi coding-agent backend for [skelm](https://github.com/scottgl9/skelm) through [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) with native tool allowlist enforcement.

[![npm](https://img.shields.io/npm/v/@skelm/pi)](https://www.npmjs.com/package/@skelm/pi)

Part of [skelm](https://github.com/scottgl9/skelm).

## Install

```bash
npm install @skelm/pi @earendil-works/pi-coding-agent
```

## Backend

Register the backend via `instances:` in `skelm.config.ts` and reference it by id on each step:

```ts
// skelm.config.ts
import { defineConfig } from 'skelm'
import { createPiSdkBackend } from '@skelm/pi'

export default defineConfig({
  backends: { agent: 'pi' },
  instances: [
    createPiSdkBackend({
      id: 'pi',
      // cwd: './workspace',  // defaults to process.cwd()
      // timeout: 300_000,    // ms; default 5 min
      // maxConcurrent: 4,    // queued beyond this; 0 = unlimited
    }),
  ],
  registries: {
    skills: { glob: 'skills/**/SKILL.md' },
  },
})
```

The CLI also wires a `backends.pi` entry to the SDK backend:

```ts
import { defineConfig } from 'skelm'

export default defineConfig({
  backends: {
    agent: 'pi',
    pi: {
      provider: 'openai',
      model: 'qwen36',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'unused',
      maxConcurrent: 4,
    },
  },
})
```

A workflow that reviews a PR using a **skill** that encodes your team's style guide:

```ts
// workflows/review-pr.workflow.mts
import { agent, pipeline } from 'skelm'
import { z } from 'zod'

export default pipeline({
  id: 'review-pr',
  input:  z.object({ diff: z.string() }),
  output: z.object({ verdict: z.string(), notes: z.array(z.string()) }),
  steps: [
    agent({
      id: 'reviewer',
      backend: 'pi',
      skills: ['style-guide'],             // injected from skills/style-guide/SKILL.md
      prompt: (ctx) =>
        `Review this diff against the style guide and return JSON {verdict, notes}:\n\n${ctx.input.diff}`,
      permissions: {
        allowedTools:       [],
        allowedExecutables: [],
        allowedMcpServers:  [],
        allowedSkills:      ['style-guide'],
        networkEgress:      'deny',
        fsRead:             [],
        fsWrite:            [],
      },
      output: z.object({ verdict: z.string(), notes: z.array(z.string()) }),
      maxTurns: 3,
    }),
  ],
})
```

### System prompt

By default pi's coding-agent system prompt is kept active. `req.system` and skill blocks are appended after it.

```ts
// append step-level system context to pi's default prompt (default)
agent({ system: 'Follow the project style guide.', ... })

// replace pi's base prompt entirely (use sparingly)
createPiSdkBackend({ systemPrompt: 'You are a TypeScript refactoring specialist.' })
```

### Sandbox defaults

The SDK backend enables predictable sandboxing out of the box:

| Option | Default | Reason |
|---|---|---|
| `noExtensions` | `true` | `.pi/extensions/` can register tools and intercept messages in ways skelm cannot audit |
| `noSkills` | `true` | skelm injects skills itself; loading `.pi/skills/` would cause duplicates |
| `noContextFiles` | `false` | `AGENTS.md` and `.pi/context/` are useful project context |

Opt back in at the backend level:

```ts
createPiSdkBackend({
  noExtensions: false,   // allow project extensions
  noSkills: false,       // also load .pi/skills/ from cwd
  noContextFiles: true,  // suppress cwd context files
})
```

### Permission to tool mapping

`derivePiToolAllowlist(policy)` translates a skelm `ResolvedPolicy` into pi's native tool names:

| skelm permission | pi tools enabled |
|---|---|
| author-declared non-empty `allowedExecutables` | **refused** — pi has no exact per-binary allowlist |
| operator/default policy includes `bash` or `sh` | `bash` |
| `fsRead.size > 0` | `read`, `grep`, `find`, `ls` |
| `fsWrite.size > 0` | `write`, `edit` (+ read tools) |
| policy `undefined` | no override; pi uses its defaults |
| policy present, nothing granted | `noTools: 'all'`; all built-ins suppressed |

### Permission semantics

Pi enforces a process-level tool allowlist. Two consequences worth knowing:

- **`bash` is all-or-nothing.** Pi has a single `bash` tool, not per-binary tools. A workflow-authored non-empty `allowedExecutables` list is refused because Pi cannot enforce it exactly; operator defaults may still enable the coarse bash tool for isolated deployments.
- **Filesystem paths are advisory.** `fsRead`/`fsWrite` paths unlock the category of filesystem tools, but pi's `read`/`write`/`grep`/`find`/`ls` tools can access anywhere the pi process has filesystem permission.

If you need per-binary or per-path enforcement, use a wrapped backend such as `@skelm/agent` and route privileged operations through helpers skelm can intercept. Use the Pi backend when Pi runs inside an isolated workspace, OS sandbox, or container that already bounds filesystem and shell access.

## Skills

Pi supports skelm skills. Declare them on the `agent()` step:

```ts
agent({
  id: 'implement',
  backend: 'pi',
  skills: ['code-review', 'style-guide'],
  prompt: 'Implement the feature.',
})
```

Skills are injected into the system prompt via `formatSkillBlock` (includes the skill's description, compatibility, and allowed-tools metadata before the body).

## Exports

```ts
export { PiProvider, createPiProvider } from '@skelm/pi'
export { createPiSdkBackend, derivePiToolAllowlist, PiSdkBackendError,
         PiSdkBackendAuthenticationError, PiSdkBackendTimeoutError } from '@skelm/pi'
export { PiSdkClient, PiSdkUpstreamError } from '@skelm/pi'
export type { PiSdkBackendOptions, PiSdkClientOptions, PiSdkResponse } from '@skelm/pi'
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

[MIT](LICENSE)
