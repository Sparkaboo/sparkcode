import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { GlobeIcon, LoaderCircleIcon, SquareIcon } from "lucide-react";
import { memo, type MouseEvent, type ReactNode, useState } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { isMacPlatform } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { openDiscoveredPort } from "../preview/openDiscoveredPort";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const serverKey = (server: DiscoveredLocalServer) => `${server.pid ?? "p"}:${server.port}`;

export interface ProjectPortsHoverMenuProps {
  readonly ports: ReadonlyArray<DiscoveredLocalServer>;
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly onOpenTerminal?: (() => void) | undefined;
}

export const ProjectPortsHoverMenu = memo(function ProjectPortsHoverMenu({
  ports,
  threadRef = null,
  onOpenTerminal,
}: ProjectPortsHoverMenuProps) {
  if (ports.length === 0) {
    return null;
  }
  if (!threadRef) {
    return <ProjectPortsStaticMenu ports={ports} onOpenTerminal={onOpenTerminal} />;
  }
  return (
    <ProjectPortsConnectedMenu
      ports={ports}
      threadRef={threadRef}
      onOpenTerminal={onOpenTerminal}
    />
  );
});

function ProjectPortsMenuShell({
  count,
  subtitle,
  onOpenTerminal,
  children,
}: {
  readonly count: number;
  readonly subtitle: string;
  readonly onOpenTerminal?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={60}
        closeDelay={160}
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`监听端口 (${count})`}
            data-project-ports-trigger
            onClick={onOpenTerminal}
          />
        }
      >
        <span className="relative flex items-center justify-center">
          <GlobeIcon className="size-3.5" aria-hidden />
          <span className="pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-success ring-1 ring-background" />
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" sideOffset={6} padding="none" className="w-80">
        <div className="flex w-full flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-foreground">监听端口</span>
              <span className="font-mono text-2xs text-muted-foreground tabular-nums">{count}</span>
            </div>
            <span className="text-2xs text-muted-foreground">{subtitle}</span>
          </div>
          <ul className="m-0 flex max-h-64 list-none flex-col gap-0.5 overflow-y-auto p-1">
            {children}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PortRowSummary({
  server,
  displayUrl,
}: {
  readonly server: DiscoveredLocalServer;
  readonly displayUrl: string;
}) {
  return (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="size-1.5 shrink-0 rounded-full bg-success" />
          <span className="font-mono text-xs font-medium text-foreground tabular-nums">
            :{server.port}
          </span>
          {server.processName ? (
            <span className="truncate text-xs text-muted-foreground">{server.processName}</span>
          ) : null}
        </span>
        <span className="truncate pl-3 font-mono text-2xs text-muted-foreground">{displayUrl}</span>
      </span>
      <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
        {server.pid !== null ? `PID ${server.pid}` : "PID 未知"}
      </span>
    </>
  );
}

function ProjectPortsStaticMenu({
  ports,
  onOpenTerminal,
}: {
  readonly ports: ReadonlyArray<DiscoveredLocalServer>;
  readonly onOpenTerminal?: (() => void) | undefined;
}) {
  return (
    <ProjectPortsMenuShell
      count={ports.length}
      subtitle={`${ports.length} 个服务`}
      onOpenTerminal={onOpenTerminal}
    >
      {ports.map((server) => (
        <li
          key={serverKey(server)}
          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
        >
          <PortRowSummary server={server} displayUrl={server.url} />
        </li>
      ))}
    </ProjectPortsMenuShell>
  );
}

function ProjectPortsConnectedMenu({
  ports,
  threadRef,
  onOpenTerminal,
}: {
  readonly ports: ReadonlyArray<DiscoveredLocalServer>;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenTerminal?: (() => void) | undefined;
}) {
  const { environmentId } = threadRef;
  const canOpenPreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(previewEnvironment.stopLocalServer.permissionAtom(environmentId));
  const supportsStop =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.localServerStop === true;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "project port stop",
  });
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);
  const externalClickHint = isMacPlatform(navigator.platform) ? "⌘+点击" : "Ctrl+点击";

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const handleOpenPort = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    const resolvedUrl = resolveDiscoveredServerUrl(environmentId, server.url);
    if (event.metaKey || event.ctrlKey || event.button === 1 || !canOpenPreview) {
      event.preventDefault();
      await readLocalApi()
        ?.shell.openExternal(resolvedUrl)
        .catch((error: unknown) => reportFailure("无法在系统浏览器打开", error));
      return;
    }
    const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("无法打开预览", squashAtomCommandFailure(result));
    }
  };

  const handleStopPort = async (server: DiscoveredLocalServer) => {
    if (server.pid === null || stoppingKey !== null) return;
    const key = serverKey(server);
    setStoppingKey(key);
    const result = await stopServer({
      environmentId,
      input: { pid: server.pid, port: server.port },
    });
    setStoppingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("停止端口进程失败", squashAtomCommandFailure(result));
    }
  };

  return (
    <ProjectPortsMenuShell
      count={ports.length}
      subtitle={`点击预览 · ${externalClickHint}浏览器`}
      onOpenTerminal={onOpenTerminal}
    >
      {ports.map((server) => {
        const key = serverKey(server);
        const stoppable = canStop && supportsStop && server.pid !== null;
        const resolvedUrl = resolveDiscoveredServerUrl(environmentId, server.url);
        return (
          <li
            key={key}
            className="group/port flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent/70"
          >
            <button
              type="button"
              onClick={(event) => void handleOpenPort(server, event)}
              onAuxClick={(event) => void handleOpenPort(server, event)}
              className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <PortRowSummary server={server} displayUrl={resolvedUrl} />
            </button>

            {stoppable ? (
              <span className="flex shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/port:opacity-100">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-destructive"
                        size="icon-micro"
                        aria-label={`停止端口 :${server.port} (PID ${server.pid})`}
                        disabled={stoppingKey !== null}
                        onClick={() => void handleStopPort(server)}
                      />
                    }
                  >
                    {stoppingKey === key ? (
                      <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                    ) : (
                      <SquareIcon aria-hidden className="size-2.5 fill-current" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="left">停止进程 (PID {server.pid})</TooltipPopup>
                </Tooltip>
              </span>
            ) : null}
          </li>
        );
      })}
    </ProjectPortsMenuShell>
  );
}
