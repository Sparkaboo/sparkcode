import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { makeProjectGroupTerminalThreadId } from "./lib/projectGroupTerminal";
import { useThreadShellsForProjectRefs } from "./state/entities";
import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);
const EMPTY_PROJECT_REFS = Object.freeze([]);

interface DiscoveredPortsState {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly configuredUrlProbing: boolean;
}

export function boundConfiguredLocalServerUrls(
  urls: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (raw.length === 0 || raw.length > PREVIEW_URL_MAX_LENGTH || raw.trim().length !== raw.length)
      continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!isLoopbackHost(url.hostname) || url.href.length > PREVIEW_URL_MAX_LENGTH) continue;
      const resourceUrl = new URL(url.href);
      resourceUrl.hash = "";
      if (seen.has(resourceUrl.href)) continue;
      seen.add(resourceUrl.href);
      bounded.push(url.href);
      if (bounded.length >= CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS) break;
    } catch {}
  }
  return bounded;
}

function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
  configuredUrls?: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> {
  return useDiscoveredPortsState(environmentId, configuredUrls).servers;
}

export function useDiscoveredPortsState(
  environmentId: EnvironmentId | null,
  configuredUrls?: ReadonlyArray<string>,
): DiscoveredPortsState {
  const boundedConfiguredUrls = boundConfiguredLocalServerUrls(configuredUrls);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({
          environmentId,
          input: boundedConfiguredUrls.length ? { configuredUrls: boundedConfiguredUrls } : {},
        }),
  );
  return {
    servers: query.data?.servers ?? EMPTY_PORTS,
    configuredUrlProbing: query.data?.configuredUrlProbing === true,
  };
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return input.threadId
    ? ports.filter(
        (port) =>
          port.terminal?.threadId === input.threadId || port.agent?.threadId === input.threadId,
      )
    : EMPTY_PORTS;
}

export function selectProjectGroupDiscoveredPorts(input: {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly projectId: ProjectId;
  readonly projectThreadIds: ReadonlySet<ThreadId>;
}): ReadonlyArray<DiscoveredLocalServer> {
  if (input.servers.length === 0) return EMPTY_PORTS;
  const groupTerminalThreadId = makeProjectGroupTerminalThreadId(input.projectId);
  const byPort = new Map<number, DiscoveredLocalServer>();
  for (const server of input.servers) {
    const ownedByGroupTerminal = server.terminal?.threadId === groupTerminalThreadId;
    const ownedByProjectThread =
      (server.terminal !== null && input.projectThreadIds.has(server.terminal.threadId)) ||
      (server.agent != null && input.projectThreadIds.has(server.agent.threadId));
    if (!ownedByGroupTerminal && !ownedByProjectThread) continue;
    // Prefer group-terminal attribution when duplicate listeners bind IPv4 + IPv6 on the same port.
    if (!byPort.has(server.port) || ownedByGroupTerminal) {
      byPort.set(server.port, server);
    }
  }
  if (byPort.size === 0) return EMPTY_PORTS;
  return [...byPort.values()].toSorted((left, right) => left.port - right.port);
}

export function useProjectGroupDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const servers = useDiscoveredPorts(input.environmentId);
  const projectRefs =
    input.environmentId !== null && input.projectId !== null
      ? [scopeProjectRef(input.environmentId, input.projectId)]
      : EMPTY_PROJECT_REFS;
  const projectThreads = useThreadShellsForProjectRefs(projectRefs);
  if (input.environmentId === null || input.projectId === null || servers.length === 0) {
    return EMPTY_PORTS;
  }
  const projectThreadIds = new Set<ThreadId>(projectThreads.map((thread) => thread.id));
  return selectProjectGroupDiscoveredPorts({
    servers,
    projectId: input.projectId,
    projectThreadIds,
  });
}
