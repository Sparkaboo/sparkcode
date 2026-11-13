import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { deriveQuickUsageOverview } from "./usageQuickPopover.logic";

const now = Date.parse("2026-11-13T12:00:00.000Z");

function makeProvider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "dev@example.com" },
    checkedAt: "2026-11-13T11:55:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("deriveQuickUsageOverview", () => {
  it("merges subscription limit windows and recent spend per provider in priority order", () => {
    const presentations: LimitPresentations = new Map([
      [
        EnvironmentId.make("env-local"),
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("claudeAgent"),
                driver: ProviderDriverKind.make("claudeAgent"),
                usageLimits: {
                  checkedAt: "2026-11-13T11:58:00.000Z",
                  windows: [
                    {
                      id: "five_hour",
                      kind: "session",
                      label: "Session",
                      usedPercent: 35,
                      windowDurationMins: 300,
                      resetsAt: "2026-11-13T14:00:00.000Z",
                    },
                  ],
                },
              }),
              makeProvider({
                instanceId: ProviderInstanceId.make("opencode"),
                driver: ProviderDriverKind.make("opencode"),
              }),
            ],
          },
        },
      ],
    ]);

    const overview = deriveQuickUsageOverview({
      presentations,
      mergedUsage: {
        costUsd: 4.5,
        totalTokens: 320_000,
        providers: [
          {
            provider: "claude",
            costUsd: 3.25,
            totalTokens: 220_000,
            records: 10,
            sessions: 2,
            costShare: 0.72,
            tokenShare: 0.68,
          },
          {
            provider: "pi",
            costUsd: 1.25,
            totalTokens: 100_000,
            records: 5,
            sessions: 1,
            costShare: 0.28,
            tokenShare: 0.32,
          },
        ],
        models: [
          {
            provider: "claude",
            model: "claude-sonnet-4-5",
            costUsd: 3.25,
            totalTokens: 220_000,
            tokens: {
              uncachedInputTokens: 100_000,
              cachedInputTokens: 80_000,
              cacheCreationTokens: 10_000,
              outputTokens: 30_000,
              reasoningTokens: 0,
            },
            records: 10,
            unpricedRecords: 0,
            unpricedTokens: 0,
            costShare: 0.72,
            tokenShare: 0.68,
          },
        ],
      },
      now,
    });

    expect(overview.items.map((item) => item.label)).toEqual(["Claude Code", "Pi", "OpenCode"]);
    expect(overview.items[0]).toMatchObject({
      label: "Claude Code",
      recentCostUsd: 3.25,
      recentTokens: 220_000,
      windows: [
        {
          label: "Session",
          remainingPercent: 65,
          resetsLabel: "↻ 2h 0m",
        },
      ],
    });
    expect(overview.items[1]).toMatchObject({
      label: "Pi",
      recentCostUsd: 1.25,
      recentTokens: 100_000,
      windows: [],
    });
    expect(overview.items[2]).toMatchObject({
      label: "OpenCode",
      recentCostUsd: null,
      recentTokens: 0,
      windows: [],
    });
  });

  it("omits dollar figures when all records for a provider are unpriced", () => {
    const presentations: LimitPresentations = new Map();
    const overview = deriveQuickUsageOverview({
      presentations,
      mergedUsage: {
        costUsd: 0,
        totalTokens: 150_000,
        providers: [
          {
            provider: "antigravity",
            costUsd: 0,
            totalTokens: 150_000,
            records: 4,
            sessions: 1,
            costShare: 0,
            tokenShare: 1,
          },
        ],
        models: [
          {
            provider: "antigravity",
            model: "gemini-4-carbon",
            costUsd: 0,
            totalTokens: 150_000,
            tokens: {
              uncachedInputTokens: 100_000,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 50_000,
              reasoningTokens: 0,
            },
            records: 4,
            unpricedRecords: 4,
            unpricedTokens: 150_000,
            costShare: 0,
            tokenShare: 1,
          },
        ],
      },
      now,
    });

    expect(overview.totalRecentCostUsd).toBeNull();
    expect(overview.totalRecentTokens).toBe(150_000);
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({
      label: "Antigravity",
      recentCostUsd: null,
      recentTokens: 150_000,
    });
  });

  it("filters out hidden providers", () => {
    const presentations: LimitPresentations = new Map([
      [
        EnvironmentId.make("env-local"),
        {
          entry: { target: { label: "Local" } },
          serverConfig: {
            providers: [
              makeProvider({
                instanceId: ProviderInstanceId.make("codex"),
                driver: ProviderDriverKind.make("codex"),
              }),
              makeProvider({
                instanceId: ProviderInstanceId.make("cursor"),
                driver: ProviderDriverKind.make("cursor"),
              }),
            ],
          },
        },
      ],
    ]);

    const overview = deriveQuickUsageOverview({
      presentations,
      mergedUsage: {
        costUsd: 0,
        totalTokens: 0,
        providers: [],
        models: [],
      },
      now,
      hiddenProviders: new Set(["cursor"]),
    });

    expect(overview.items.map((item) => item.label)).toEqual(["Codex"]);
  });
});
