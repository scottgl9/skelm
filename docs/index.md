---
layout: home
title: skelm
titleTemplate: TypeScript framework for secure, agentic workflows

hero:
  name: skelm
  text: Build secure, agentic, long-running workflows in TypeScript
  tagline: Default-deny permissions · Multi-backend agents · MCP-native · Self-hosted
  actions:
    - theme: brand
      text: Quick Start
      link: /quickstart/
    - theme: alt
      text: View on GitHub
      link: https://github.com/scottgl9/skelm
  image:
    src: /logo.svg
    alt: skelm

features:
  - icon: 🔒
    title: Default-Deny Security
    details: Every agent step declares allowed tools, executables, MCP servers, network egress, and filesystem roots.
  - icon: ⚡
    title: TypeScript-Native
    details: Workflows are real .ts modules — refactor, test, type-check, version like any other code.
  - icon: 🧩
    title: Multi-Backend Agents
    details: Opencode, ACP (Copilot, Claude Code, Gemini), OpenAI, Anthropic, Pi — provider SPI for custom ones.
  - icon: 🌐
    title: MCP-Native
    details: Model Context Protocol servers are first-class registry citizens, lifecycle-managed by the gateway.
  - icon: 🔄
    title: Long-Running Gateway
    details: Hosts workflows over HTTP + SSE, drives the scheduler, owns the trust boundary.
  - icon: 💾
    title: Local-First
    details: SQLite by default; Postgres + vault drivers for production. No managed cloud, no telemetry.
---
