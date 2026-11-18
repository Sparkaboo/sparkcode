---
date: 2026-11-18
slug: upstream-fixes-and-native-resume
title: SparkCode backports from T3 Code v0.1.10
tags: [upstream, providers, resume]
related: []
---

## Backport scope

SparkCode diverged at upstream commit `36371de910`. Nine upstream changes were selected from the stable v0.1.10 release. The full merge would also pull in 1,109 upstream commits and conflict with locally maintained workspace, ACP and terminal behavior.

- Antigravity helper availability and skill discovery: #36496, #32182.
- Codex quota reads and accounting for replayed usage snapshots: #36189, #36367.
- Checkpoint file restore reservations and shared terminal sizing: #23671, #36647.
- Native resume, Cursor support and replay of an unaccepted replacement request: #36526, #36918, #36677.

## Integration

Claude keeps this fork's existing attachment and skill processing on ordinary turns. Cursor's SDK patch and lockfile use 1.3.1. If an older attempt was accepted and a later steering restart was interrupted before reaching the provider, the replacement message still needs delivery.

## Verification

An integration test reproduced an empty prompt and missing attachment before #36677, then observed one delivery with the replacement text and PNG attachment. The changed-file run passed 1,550 tests and typechecked 41 packages. The unlocked dependency check independently failed on the original checkout when the registry resolved unenv rc.25 for the relay's rc.24 peer. Installing the frozen lockfile succeeded.
