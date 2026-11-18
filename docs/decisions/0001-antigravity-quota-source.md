---
id: 0001
slug: antigravity-quota-source
date: 2026-11-18
title: Read personal Antigravity quotas from the native CLI
status: Accepted
tags: [antigravity, usage]
supersedes: []
superseded_by:
---

## Context

A personal Google account can authenticate in ACP while its profile has no token file. The native CLI can select a different account from the one a SparkCode provider instance uses.

## Decision

When a personal profile has a saved sign-in and no readable profile token, both periodic health checks and manual refresh can run `agy --print /usage --output-format json`. They share one in-flight read per provider instance. Require a CLI version that supports this read-only command, a successful zero-turn response, and matching authenticated accounts in the two startup logs. A transient failure preserves the last successful reading.

## Alternatives considered

The interactive CLI status line also reports quotas, but requires a terminal session. During verification, sending `/usage` through ACP started a model request. Print mode returns the structured quota groups directly.

## Consequences

The sidebar and Limits page can share the existing provider snapshot. If a runtime stops reporting its identity in startup logs, the native reading stays unavailable until the account can be verified again.
