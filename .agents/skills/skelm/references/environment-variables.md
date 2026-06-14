# Environment variables

A single reference for every environment variable skelm reads at runtime, grouped
by the area it affects.

Most of these are **non-secret defaults** (model names, base URLs, paths, timeouts).
For real secrets, prefer a `step.secrets` declaration backed by the configured
`secrets.driver` rather than a raw environment variable — see
[Secrets](/guides/secrets). For how skelm layers `.env` and `config.env` into
`process.env`, and the `process.env > .env > config.env` precedence, see
[Config reference](/reference/config#environment-variables-env-and-config-env).

## LLM / backend credentials & routing

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | API key for the OpenAI backend. Used as a fallback when no inline `apiKey` is provided. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Endpoint for the OpenAI backend. Set this to route to a compatible/proxy server. |
| `ANTHROPIC_API_KEY` | — | API key for the Anthropic backend. Fallback when no inline `apiKey` is provided. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Endpoint for the Anthropic backend. |
| `OPENAI_PROVIDER` | `openai` | Provider selector for the Pi SDK backend (e.g. `openai`, `anthropic`). |
| `OPENAI_MODEL` | backend default | Model id for the Pi SDK backend (e.g. `gpt-4o`). |
| `CODEX_API_KEY` | — | Authentication key passed through to the Codex SDK subprocess. |
| `OPENCODE_API_KEY` | — | API key for the Opencode backend. |
| `SKELM_BUILDER_BACKEND` | — | Overrides the backend used by the workflow builder (`codex` or `pi`). |

The Pi SDK backend also reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` (see above).

## Gateway client and state (CLI → gateway)

These configure how the `skelm` CLI discovers, starts, and talks to the gateway.

| Variable | Default | Description |
| --- | --- | --- |
| `SKELM_STATE_DIR` | `~/.skelm` | Directory for gateway runtime state (discovery file, logs, approvals). Must be consistent across processes sharing a gateway. |
| `SKELM_GATEWAY_URL` | — | Explicit URL of a running gateway. When set, the CLI skips state-dir discovery and auto-start (use this to target a remote gateway). |
| `SKELM_GATEWAY_TOKEN` | — | Bearer token sent to the gateway when `SKELM_GATEWAY_URL` is set. |
| `SKELM_GATEWAY_LOG` | `$SKELM_STATE_DIR/gateway.log` | Path the `skelm logs` command reads the gateway log from. |
| `SKELM_GATEWAY_READY_TIMEOUT_MS` | `15000` | How long the CLI waits for an auto-started gateway to become ready, in milliseconds. Raise for slow/cold-start machines. |
| `SKELM_NO_AUTOSTART` | unset (auto-start on) | Set to `1` to disable automatic gateway start; the gateway must already be running. |
| `SKELM_AUTOSTART_IN_CI` | unset (off in CI) | Set to `1` to allow auto-start even when `CI` is set. |
| `CI` | — | Standard CI marker. When set, the CLI disables gateway auto-start unless `SKELM_AUTOSTART_IN_CI=1`. |
| `SKELM_APPROVALS_CONFIG` | `$SKELM_STATE_DIR/approvals.config.json` | Path to the approval-policy config (request timeouts, approver registry). |

## Gateway server and security

Read by the gateway process itself.

| Variable | Default | Description |
| --- | --- | --- |
| `SKELM_TOKEN` | — | Bearer token for gateway authentication, used as a fallback when no token is set in code. Required when the server `auth` mode is `token`. |
| `SKELM_DEV_CORS` | unset (off) | Opt-in development CORS. Unset/empty/`0`/`false` keeps it off; `1`/`true` reflects the request `Origin`; any other value is used as the explicit allowed origin. Default-deny is preserved when unset. |
| `SKELM_UNRESTRICTED_WORKFLOWS` | — | Comma-separated list of workflow ids granted unrestricted permissions. Works alongside `config.defaults.unrestrictedGrants`. Widening this is a security event — see [Permissions](/reference/permissions). |

## Egress proxy

When the gateway enforces `networkEgress`, it **emits** these into backend
subprocesses; the egress token is encoded as the URL credential of `HTTP_PROXY` so
standard HTTP clients route through the proxy. **Do not set these by hand** — they
are managed by the gateway.

| Variable | Description |
| --- | --- |
| `HTTP_PROXY` | Egress proxy URL injected into backend subprocesses, with the egress token as URL credential. |
| `HTTPS_PROXY` | Same value as `HTTP_PROXY`, for HTTPS clients. |
| `SKELM_EGRESS_TOKEN` | The raw egress token, also emitted for callers that read it directly. |

## Code-execution interpreters

| Variable | Default | Description |
| --- | --- | --- |
| `SKELM_PYTHON` | `python3` | Interpreter used to run Python code steps. |
| `SKELM_BASH` | `bash` | Interpreter used to run Bash code steps. |

See [External scripts](/guides/external-scripts).

## Git workspace authentication

Git workspace cloning resolves its auth token dynamically from the environment
variable named by the workspace `auth.env` config field, rather than from a fixed
variable name. Configure the variable name in your workspace config and supply its
value through your normal secrets channel — see [Secrets](/guides/secrets).
