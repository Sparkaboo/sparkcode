import {
  isProviderAvailable,
  type ServerProvider,
  type UsageProviderKind,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatResetsIn,
  type LimitPace,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { isModelCostUnknown, type MergedUsage } from "@t3tools/shared/usageMerge";

import { providerClients } from "../settings/providerDriverMeta";
import { barColor } from "./UsageLimits";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

export interface QuickLimitWindowSummary {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly pace: LimitPace | null;
  readonly resetsLabel: string | null;
}

export interface QuickProviderUsageItem {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly barColor: string;
  readonly accountCount: number;
  readonly windows: readonly QuickLimitWindowSummary[];
  readonly recentTokens: number;
  readonly recentCostUsd: number | null;
  readonly unavailableMessage: string | null;
  readonly externalUsageUrl: string | null;
}

export interface QuickUsageOverview {
  readonly items: readonly QuickProviderUsageItem[];
  readonly totalRecentTokens: number;
  readonly totalRecentCostUsd: number | null;
  readonly notices: readonly string[];
}

const USAGE_PROVIDER_BY_DRIVER = new Map<ServerProvider["driver"], UsageProviderKind>(
  PROVIDER_ORDER.map((provider) => [PROVIDER_PRESENTATION[provider].driverKind, provider]),
);

const DRIVER_ORDER_RANK = new Map<ServerProvider["driver"], number>(
  PROVIDER_ORDER.map((provider, index) => [PROVIDER_PRESENTATION[provider].driverKind, index]),
);

function compactResetLabel(poolWindow: LimitPoolWindow, now: number): string | null {
  const nextReset =
    poolWindow.resets.find((reset) => reset.restoresPercent > 0) ?? poolWindow.resets[0];
  if (!nextReset) return null;
  const formatted = formatResetsIn(nextReset.member.window, now);
  if (!formatted) return null;
  if (formatted === "Resets momentarily") return "即将重置";
  if (formatted === "resets now") return "正在重置";
  return formatted.replace(/^resets in /i, "↻ ");
}

function compactWindowLabel(driver: ServerProvider["driver"], label: string): string {
  if (driver === "antigravity") {
    return label.replace(" (shared)", "");
  }
  return label;
}

function resolveDriverLabel(
  driver: ServerProvider["driver"],
  usageProvider: UsageProviderKind | null,
): string {
  if (usageProvider !== null) {
    return PROVIDER_PRESENTATION[usageProvider].label;
  }
  return providerClients.get(driver)?.label ?? String(driver);
}

function isProviderAllUnpriced(
  mergedUsage: Pick<MergedUsage, "models">,
  provider: UsageProviderKind,
): boolean {
  const models = mergedUsage.models.filter((entry) => entry.provider === provider);
  return models.length > 0 && models.every(isModelCostUnknown);
}

export function deriveQuickUsageOverview(input: {
  readonly presentations: LimitPresentations;
  readonly mergedUsage: Pick<MergedUsage, "providers" | "models" | "costUsd" | "totalTokens">;
  readonly now: number;
  readonly hiddenProviders?: ReadonlySet<UsageProviderKind>;
}): QuickUsageOverview {
  const { presentations, mergedUsage, now, hiddenProviders } = input;
  const isHiddenDriver = (driver: ServerProvider["driver"]): boolean => {
    if (!hiddenProviders || hiddenProviders.size === 0) return false;
    const usageKind = USAGE_PROVIDER_BY_DRIVER.get(driver);
    return usageKind !== undefined && hiddenProviders.has(usageKind);
  };

  const visiblePresentations: LimitPresentations =
    !hiddenProviders || hiddenProviders.size === 0
      ? presentations
      : new Map(
          [...presentations].map(([id, presentation]) => {
            const config = presentation.serverConfig;
            if (config === null) return [id, presentation] as const;
            return [
              id,
              {
                ...presentation,
                serverConfig: {
                  ...config,
                  providers: config.providers.filter(
                    (provider) => !isHiddenDriver(provider.driver),
                  ),
                  usageLimitSources: config.usageLimitSources?.flatMap((source) => {
                    const accounts = source.accounts.filter(
                      (account) => !isHiddenDriver(account.driver),
                    );
                    return accounts.length === 0 && source.accounts.length > 0
                      ? []
                      : [{ ...source, accounts }];
                  }),
                },
              },
            ] as const;
          }),
        );

  const accounts = collectLimitAccounts(visiblePresentations);
  const pools = collectLimitPools(accounts, now);
  const poolByDriver = new Map(pools.map((pool) => [pool.driver, pool]));

  const providerMetaByDriver = new Map<
    ServerProvider["driver"],
    {
      connected: boolean;
      externalUsageUrl: string | null;
      unavailableMessage: string | null;
    }
  >();

  for (const presentation of visiblePresentations.values()) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!provider.enabled || !provider.installed || !isProviderAvailable(provider)) continue;
      const isAuthenticated = provider.auth.status === "authenticated";
      if (!isAuthenticated && provider.usageLimits === undefined) continue;

      const existing = providerMetaByDriver.get(provider.driver) ?? {
        connected: false,
        externalUsageUrl: null,
        unavailableMessage: null,
      };
      const externalUrl =
        isAuthenticated && provider.usageLimits?.externalUsage?.url
          ? provider.usageLimits.externalUsage.url
          : existing.externalUsageUrl;
      const unavailableMsg =
        provider.usageLimits?.unavailable?.message ?? existing.unavailableMessage;

      providerMetaByDriver.set(provider.driver, {
        connected: existing.connected || isAuthenticated,
        externalUsageUrl: externalUrl,
        unavailableMessage: unavailableMsg,
      });
    }
  }

  const totalsByProvider = new Map(mergedUsage.providers.map((entry) => [entry.provider, entry]));

  const candidateDrivers = new Set<ServerProvider["driver"]>([
    ...poolByDriver.keys(),
    ...providerMetaByDriver.keys(),
  ]);

  for (const entry of mergedUsage.providers) {
    if (hiddenProviders?.has(entry.provider)) continue;
    if (entry.totalTokens > 0 || entry.costUsd > 0) {
      candidateDrivers.add(PROVIDER_PRESENTATION[entry.provider].driverKind);
    }
  }

  const unsortedItems: QuickProviderUsageItem[] = [];
  for (const driver of candidateDrivers) {
    const usageProvider = USAGE_PROVIDER_BY_DRIVER.get(driver) ?? null;
    const pool = poolByDriver.get(driver);
    const meta = providerMetaByDriver.get(driver);
    const usageTotals = usageProvider ? totalsByProvider.get(usageProvider) : undefined;

    const windows: QuickLimitWindowSummary[] = pool
      ? displayLimitWindows(pool).map((window) => {
          const details = driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : null;
          const label = details
            ? (details.label ?? "Overall")
            : compactWindowLabel(driver, window.label);
          return {
            id: `${window.kind}:${window.id}`,
            label,
            remainingPercent: window.remainingPercent,
            pace: window.pace,
            resetsLabel: compactResetLabel(window, now),
          };
        })
      : [];

    const recentTokens = usageTotals?.totalTokens ?? 0;
    const rawCost = usageTotals?.costUsd ?? 0;
    const allUnpriced =
      usageProvider !== null &&
      recentTokens > 0 &&
      isProviderAllUnpriced(mergedUsage, usageProvider);
    const recentCostUsd = allUnpriced ? null : rawCost > 0 ? rawCost : null;

    const hasActivity =
      windows.length > 0 ||
      recentTokens > 0 ||
      recentCostUsd !== null ||
      Boolean(meta?.externalUsageUrl) ||
      Boolean(meta?.connected);

    if (!hasActivity) continue;

    unsortedItems.push({
      key: String(driver),
      driver,
      label: resolveDriverLabel(driver, usageProvider),
      barColor: barColor(driver),
      accountCount: pool?.accounts.length ?? 0,
      windows,
      recentTokens,
      recentCostUsd,
      unavailableMessage: windows.length === 0 ? (meta?.unavailableMessage ?? null) : null,
      externalUsageUrl: meta?.externalUsageUrl ?? null,
    });
  }

  const inlineNoticeDrivers = new Set(
    unsortedItems.filter((item) => item.unavailableMessage !== null).map((item) => item.driver),
  );
  const noticePresentations: LimitPresentations =
    inlineNoticeDrivers.size === 0
      ? visiblePresentations
      : new Map(
          [...visiblePresentations].map(([id, presentation]) => {
            const config = presentation.serverConfig;
            if (config === null) return [id, presentation] as const;
            return [
              id,
              {
                ...presentation,
                serverConfig: {
                  ...config,
                  providers: config.providers.filter(
                    (provider) => !inlineNoticeDrivers.has(provider.driver),
                  ),
                },
              },
            ] as const;
          }),
        );

  const activityTier = (item: QuickProviderUsageItem): number => {
    if (item.windows.length > 0) return 0;
    if (item.recentTokens > 0 || item.recentCostUsd !== null) return 1;
    return 2;
  };

  const items = unsortedItems.toSorted((left, right) => {
    const tierDiff = activityTier(left) - activityTier(right);
    if (tierDiff !== 0) return tierDiff;
    const rankLeft = DRIVER_ORDER_RANK.get(left.driver) ?? Number.MAX_SAFE_INTEGER;
    const rankRight = DRIVER_ORDER_RANK.get(right.driver) ?? Number.MAX_SAFE_INTEGER;
    if (rankLeft !== rankRight) return rankLeft - rankRight;
    return left.label.localeCompare(right.label);
  });

  const allGlobalUnpriced =
    mergedUsage.totalTokens > 0 &&
    mergedUsage.models.length > 0 &&
    mergedUsage.models.every(isModelCostUnknown);

  const notices = collectLimitNotices(noticePresentations);

  return {
    items,
    totalRecentTokens: mergedUsage.totalTokens,
    totalRecentCostUsd: allGlobalUnpriced
      ? null
      : mergedUsage.costUsd > 0
        ? mergedUsage.costUsd
        : null,
    notices,
  };
}
