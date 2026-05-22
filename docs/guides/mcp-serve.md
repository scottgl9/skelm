# `skelm mcp serve`

`skelm mcp serve` exposes skelm pipelines as Model Context Protocol tools over stdio. Any MCP-compatible client can start the CLI, list available tools, and invoke a workflow by tool name.

## Usage

    skelm mcp serve [workflow.mts...] [--port <n>]

`--port` is reserved for a future transport. This release supports stdio only.

When you omit workflow paths, skelm discovers workflows from the current project using the configured pipeline glob.

## Client configuration

Claude Code example:

    {
      "mcpServers": {
        "skelm": {
          "command": "skelm",
          "args": ["mcp", "serve"]
        }
      }
    }

Cursor example:

    {
      "mcpServers": {
        "skelm": {
          "command": "skelm",
          "args": ["mcp", "serve", "workflows/pr-review.workflow.mts"]
        }
      }
    }

Generic MCP client example:

    {
      "mcp_servers": {
        "skelm": {
          "command": "skelm",
          "args": ["mcp", "serve"]
        }
      }
    }

## Tool naming

A workflow like `pr-review.workflow.mts` that exports a pipeline with `id: "pr-review"` becomes an MCP tool named `pr-review`.

If a pipeline id contains `/`, skelm rewrites it to `-` for the MCP tool name so clients receive a safe tool identifier.

## Permissions

The pipeline's declared permissions still apply. The MCP client only gets the capabilities granted by the workflow itself; exposing a workflow as a tool does not widen the workflow's permission envelope.

## Transport status

`skelm mcp serve` is stdio only in this release. HTTP transport is planned.
