import { useAtomValue } from "@effect/atom-react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { ChartNoAxesColumnIcon, ExternalLinkIcon, Maximize2Icon } from "lucide-react";
import {
  Fragment,
  memo,
  type MouseEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useUsage } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PaceIcon } from "./UsageLimits";
import { readUsagePagePreferences } from "./usagePagePreferences";
import { deriveQuickUsageOverview, type QuickProviderUsageItem } from "./usageQuickPopover.logic";

function formatRecentSpendBadge(costUsd: number | null, totalTokens: number): string | null {
  const parts: string[] = [];
  if (costUsd !== null) {
    parts.push(formatUsd(costUsd));
  }
  if (totalTokens > 0) {
    parts.push(`${formatTokens(totalTokens)} tok`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ProviderUsageRow({ item }: { readonly item: QuickProviderUsageItem }) {
  const spendBadge = formatRecentSpendBadge(item.recentCostUsd, item.recentTokens);

  return (
    <li className="flex flex-col px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderInstanceIcon
            driverKind={item.driver}
            displayName={item.label}
            indicatorBackground="var(--popover)"
            className="size-4 shrink-0"
            iconClassName="size-3.5 text-foreground/85"
          />
          <span className="truncate text-xs font-medium text-foreground">{item.label}</span>
          {item.accountCount > 1 ? (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-3xs leading-none text-muted-foreground tabular-nums">
              {item.accountCount}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {spendBadge ? (
            <span className="font-mono text-2xs text-muted-foreground tabular-nums">
              {spendBadge}
            </span>
          ) : item.windows.length === 0 && !item.externalUsageUrl && !item.unavailableMessage ? (
            <span className="text-2xs text-muted-foreground/70">近 24h 无消耗</span>
          ) : null}
          {item.externalUsageUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-micro"
                    aria-label={`打开 ${item.label} 用量页面`}
                    onClick={() => {
                      if (item.externalUsageUrl) {
                        void ensureLocalApi().shell.openExternal(item.externalUsageUrl);
                      }
                    }}
                  />
                }
              >
                <ExternalLinkIcon className="size-3" aria-hidden />
              </TooltipTrigger>
              <TooltipPopup side="top">打开外部用量页面</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>

      {item.windows.length > 0 ? (
        <div className="grid grid-cols-[minmax(4.5rem,auto)_minmax(3.5rem,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 pt-2 text-2xs">
          {item.windows.map((window) => {
            const isCritical = window.remainingPercent <= 10;
            const isLow = window.remainingPercent > 10 && window.remainingPercent <= 25;
            return (
              <Fragment key={window.id}>
                <span className="max-w-44 truncate text-muted-foreground">{window.label}</span>
                <div
                  role="progressbar"
                  aria-label={`${item.label} ${window.label}`}
                  aria-valuenow={window.remainingPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="relative h-1.5 min-w-14 overflow-hidden rounded-full bg-muted/80"
                >
                  {window.remainingPercent > 0 ? (
                    <div
                      className="h-full rounded-full transition-[width]"
                      style={{
                        width: `${window.remainingPercent}%`,
                        backgroundColor: item.barColor,
                      }}
                    />
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-1.5 tabular-nums">
                  {window.pace ? <PaceIcon pace={window.pace} /> : null}
                  <span
                    className={cn(
                      "w-8 text-right font-mono font-medium text-foreground",
                      isCritical && "text-destructive",
                      isLow && "text-warning-foreground",
                    )}
                  >
                    {window.remainingPercent}%
                  </span>
                  {window.resetsLabel ? (
                    <span className="min-w-12 text-right font-mono text-muted-foreground">
                      {window.resetsLabel}
                    </span>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : item.unavailableMessage ? (
        <p className="pt-1 text-2xs text-muted-foreground">{item.unavailableMessage}</p>
      ) : null}
    </li>
  );
}

function UsageQuickPopoverBody({ onOpenFullUsage }: { readonly onOpenFullUsage: () => void }) {
  const [preferences] = useState(readUsagePagePreferences);
  const hiddenProviders = new Set(preferences.hiddenProviders);
  const [recentWindow, setRecentWindow] = useState(() => makeWindow(1, undefined, "hour"));
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const {
    merged: answeredUsage,
    shown,
    isPending,
    refresh: refreshUsageSummary,
  } = useUsage(recentWindow, null, hiddenProviders);
  const merged = shown?.merged ?? answeredUsage;

  const refreshLimitsQuietly = (automatic: boolean) =>
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).then(() => {
      setLimitsNow(Date.now());
    });

  const connectedEnvironmentKeys = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null,
    )
    .map(([environmentId]) => environmentId)
    .sort()
    .join(",");

  const triggerAutoRefresh = useEffectEvent(() => {
    void refreshLimitsQuietly(true);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- silently refreshes provider rate limits when the quick popover mounts or environments connect
  useEffect(() => {
    if (connectedEnvironmentKeys) {
      triggerAutoRefresh();
    }
  }, [connectedEnvironmentKeys]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks relative reset countdowns while the popover stays open
  useEffect(() => {
    const timer = window.setInterval(() => {
      setLimitsNow(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleManualRefresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    const nextWindow = makeWindow(1, undefined, "hour");
    setRecentWindow(nextWindow);
    void Promise.allSettled([refreshLimitsQuietly(false), refreshUsageSummary(nextWindow)]).finally(
      () => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      },
    );
  };

  const overview = deriveQuickUsageOverview({
    presentations: presentationsWithProviders,
    mergedUsage: merged,
    now: limitsNow,
    hiddenProviders,
  });

  const headerSpendBadge = formatRecentSpendBadge(
    overview.totalRecentCostUsd,
    overview.totalRecentTokens,
  );

  return (
    <div className="flex w-full flex-col" data-usage-quick-popover>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3.5 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-semibold text-foreground">Usage</span>
          {headerSpendBadge ? (
            <span className="truncate font-mono text-2xs text-muted-foreground tabular-nums">
              24h · {headerSpendBadge}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="刷新额度与用量"
                  disabled={isRefreshing}
                  onClick={handleManualRefresh}
                />
              }
            >
              <RefreshIcon size="xs" refreshing={isRefreshing} />
            </TooltipTrigger>
            <TooltipPopup side="top">刷新</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="查看完整统计"
                  onClick={onOpenFullUsage}
                />
              }
            >
              <Maximize2Icon className="size-3.5" aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="top">查看完整统计</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {overview.items.length > 0 ? (
        <ul className="m-0 flex max-h-80 list-none flex-col divide-y divide-border/50 overflow-y-auto p-0">
          {overview.items.map((item) => (
            <ProviderUsageRow key={item.key} item={item} />
          ))}
        </ul>
      ) : isPending ? (
        <div className="flex flex-col gap-2.5 px-3.5 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-full" />
        </div>
      ) : (
        <div className="px-3.5 py-6 text-center text-xs text-muted-foreground">
          暂无已连接 Provider 的额度或用量记录
        </div>
      )}

      {overview.notices.length > 0 ? (
        <div className="border-t border-border/50 px-3.5 py-2 text-2xs text-muted-foreground">
          {overview.notices.map((notice) => (
            <p key={notice} className="m-0 leading-relaxed">
              {notice}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const SidebarUsagePopoverItem = memo(function SidebarUsagePopoverItem({
  onOpenFullUsage,
}: {
  readonly onOpenFullUsage: () => void;
}) {
  const [open, setOpen] = useState(false);

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      onOpenFullUsage();
    }
  };

  const handleExpandToModal = () => {
    setOpen(false);
    onOpenFullUsage();
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip disabled={open}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <SidebarMenuButton aria-label="Usage" size="icon" onClick={handleTriggerClick} />
                }
              />
            }
          >
            <ChartNoAxesColumnIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Usage</TooltipPopup>
        </Tooltip>
        <PopoverPopup side="top" align="start" sideOffset={8} padding="none" width="lg">
          <UsageQuickPopoverBody onOpenFullUsage={handleExpandToModal} />
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
});
