---
date: 2026-11-18
slug: antigravity-native-quota-refresh
title: Antigravity quota refresh in SparkCode 0.1.9
tags: [antigravity, usage, desktop]
related: [../decisions/0001-antigravity-quota-source.md]
---

## Reproduction

A macOS SparkCode 0.1.9 instance using Antigravity 1.5.10 reported an authenticated account and nine models. The quota reader returned zero windows and asked the user to sign in. The same account had four windows in the native CLI.

## Verification

Using an isolated copy of the original zero-window state, opening the sidebar Usage menu against the server embedded in the arm64 DMG populated the Gemini and shared Claude/GPT five-hour and weekly windows. The regression tests also covered an account mismatch, a model-generated reply, and an older CLI.

The local verification package retained version 0.1.9. The version number alone cannot identify which build contains the fix.
