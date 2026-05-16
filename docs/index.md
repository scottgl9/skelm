---
layout: home
title: skelm
titleTemplate: TypeScript framework for secure, agentic workflows

hero:
  name: skelm
  text: Agentic workflows you can actually ship to production
  tagline: Author pipelines as typed TypeScript. Compose them with Skills (and MCP servers when you need them). Run under default-deny permissions on a gateway you own.
  actions:
    - theme: brand
      text: Quick Start
      link: /quickstart/
    - theme: alt
      text: Browse Recipes
      link: /recipes/
    - theme: alt
      text: GitHub
      link: https://github.com/scottgl9/skelm
  image:
    src: /logo.svg
    alt: skelm

features:
  - icon: 🔒
    title: Default-deny by design
    details: Every agent step declares its tools, executables, MCP servers, network egress, and filesystem roots. Anything not listed is denied — and the gateway is the only thing that enforces it.
  - icon: 🧠
    title: Code-first, not config-first
    details: Pipelines are real `.ts` modules. Refactor with your editor, type-check with `tsc`, version with git, test with vitest. No YAML DSL to learn.
  - icon: 🧩
    title: Backend-agnostic agents
    details: Opencode, ACP (Copilot, Claude Code, Gemini), OpenAI, Anthropic, Pi — swap providers without rewriting a step. Bring your own via the backend SPI.
  - icon: 📚
    title: Skills-first capability model
    details: Package procedural knowledge — playbooks, API recipes, internal know-how — as Skills the agent loads on demand. MCP servers plug in as first-class registry citizens alongside them when you need live tools.
  - icon: 🌐
    title: Gateway-hosted runtime
    details: A long-running gateway hosts pipelines over HTTP + SSE, drives the scheduler, manages MCP-server lifecycles, and owns the trust boundary. Nothing privileged runs outside it.
  - icon: 💾
    title: Self-hosted, local-first
    details: SQLite + filesystem out of the box; Postgres and external vaults for production. No managed cloud, no telemetry phone-home, no vendor lock-in.
---

## Why skelm?

Most "agent frameworks" make it easy to demo a chatbot and impossible to operate one. Tool calls leak credentials, prompts mutate at runtime, and the production story is "trust us." Skelm is the opposite: every privileged action — exec, network, filesystem, tool dispatch, MCP — flows through a gateway under permissions you declare in code, and every workflow is a typed module you can grep, refactor, and unit-test.

It sits in a deliberately narrow niche: between a one-off LangChain script and a managed agent platform. If you want to run agentic and deterministic workflows on your own infrastructure, with security primitives that don't disappear when the demo ends, that's what skelm is for.

Start with the [Quickstart](/quickstart/) for the five-minute path, or skim the [Recipes](/recipes/) to see complete examples.
