# @skelm/cli

Command-line interface for [skelm](https://github.com/scottgl9/skelm).

This package owns the `skelm` bin and the `runCommand` / `parseArgv` / `main` primitives that the bin composes. Both the published [`skelm`](../skelm/README.md) meta package and direct workspace consumers use the same `main(argv, io)` entry point — tests can drive the CLI without spawning a subprocess.

## Install

Customers get the CLI by installing the [`skelm`](../skelm/README.md) meta package, which ships the same bin:

```sh
npm i -g skelm
skelm --help
```

`@skelm/cli` is exported separately so framework integrators (the gateway, in-process embedders, IDE extensions) can reuse the parser and command implementations.

## Commands available today

```
skelm run <workflow.ts> [flags]
skelm --version
skelm --help
```

Run flags:

```
--input <json>          Input JSON (single argument)
--input-file <path>     Input from a file
--input-stdin           Read input JSON from stdin
--events <fmt>          human (default) | json | none
```

Subsequent milestones add `skelm schedule`, `skelm gateway`, `skelm history`, `skelm secrets`, `skelm audit`, etc.

## Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `0`  | run completed                                                |
| `1`  | uncaught CLI error (bad args, file not found)                |
| `2`  | schema validation failure (input or output)                  |
| `3`  | workflow run failed (any step failed)                        |
| `4`  | run was cancelled (SIGINT)                                   |
| `5`  | wait() timed out                                             |
| `6`  | security policy violation (denied tool, exec, network, fs)   |

stdout receives the workflow's final output as JSON. Everything else (progress, JSON events when `--events json`, error messages, prompts) goes to stderr — making `skelm run foo.ts > result.json 2> events.log` work without a parser.

## Programmatic use

```ts
import { main, EXIT } from '@skelm/cli'

const result = await main(['run', './my.workflow.ts'], {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
})
process.exit(result.exitCode)
```

## Stability

`0.x` — APIs may change between minor versions until v1.

## License

MIT.
