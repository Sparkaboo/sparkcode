---
date: 2026-11-18
slug: provider-quota-auto-refresh
title: Automatic quota refresh for Antigravity and OpenCode
tags: [antigravity, opencode, usage]
related:
  [2026-11-18-antigravity-native-quota-refresh.md, ../decisions/0001-antigravity-quota-source.md]
---

## Why the sidebar stayed stale

In SparkCode v0.2.0 a manual refresh could read Antigravity's native quota report, but the scheduled status check skipped it. OpenCode had a separate issue. Its scheduler retried a failed quota read, then stopped checking once that read succeeded.

## Refresh behavior

The environment owns the refresh interval so connected clients share the same reading. Antigravity coalesces overlapping checks for one account. OpenCode can poll its quota endpoint while leaving a healthy model catalog alone. Both use the existing background activity settings.

## Verification

An isolated provider using the installed Antigravity CLI published all four Gemini and shared Claude/GPT windows twice, 15 seconds apart, through the snapshot stream. Both native reports recorded zero model turns. The OpenCode regression test changed a remote workspace's budget usage from 75% to 90% and observed the new value at the next scheduled check with no further model catalog reads. Direct desktop UI verification remains pending.
