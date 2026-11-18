---
id: 0002
slug: sparkcode-independent-versions
date: 2026-11-18
title: Version SparkCode releases independently
status: Accepted
tags: [release, desktop, cli]
supersedes: []
superseded_by:
---

## Context

Local SparkCode installations already report 0.1.9. SparkCode carries its own desktop and provider changes and incorporates selected upstream commits between releases.

## Decision

Start the public release series at v0.2.0. Tag a tested SparkCode commit and use the same numeric version in the desktop apps, CLI archives, server, web client and contracts. Record the T3 Code base and selected backports in each release's notes.

## Alternatives considered

Continuing at v0.1.10 would also sort above local 0.1.9 builds. That number is already the name of the upstream release from which the first public version takes only nine changes. Starting at v0.1.0 would sort below existing local builds.

## Consequences

Future feature and maintenance releases follow the SparkCode release schedule. Downloads and update metadata come from Sparkaboo/sparkcode. Existing 0.1.9 desktop builds without update metadata require a manual first upgrade.
