import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeProjectGroupTerminalThreadId } from "./lib/projectGroupTerminal";
import {
  boundConfiguredLocalServerUrls,
  selectProjectGroupDiscoveredPorts,
} from "./portDiscoveryState";

describe("boundConfiguredLocalServerUrls", () => {
  it("keeps subscription payloads within the discovery RPC bounds", () => {
    const urls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
      (_, index) => `http://localhost:${3_000 + index}`,
    );
    urls.unshift(
      "https://example.com",
      "not a URL",
      `http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`,
    );

    const bounded = boundConfiguredLocalServerUrls(urls);

    expect(bounded).toHaveLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS);
    expect(bounded.every((url) => url.startsWith("http://localhost:"))).toBe(true);
  });

  it("does not let fragment-only variants crowd out another server", () => {
    const fragments = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:3000/docs#section-${index}`,
    );

    expect(boundConfiguredLocalServerUrls([...fragments, "http://localhost:4000/app"])).toEqual([
      "http://localhost:3000/docs#section-0",
      "http://localhost:4000/app",
    ]);
  });
});

describe("selectProjectGroupDiscoveredPorts", () => {
  it("collects ports from both project-group terminals and threads in the same project", () => {
    const projectId = ProjectId.make("project-alpha");
    const groupThreadId = makeProjectGroupTerminalThreadId(projectId);
    const memberThreadId = ThreadId.make("thread-alpha-1");
    const unrelatedThreadId = ThreadId.make("thread-beta-1");

    const ports = selectProjectGroupDiscoveredPorts({
      projectId,
      projectThreadIds: new Set([memberThreadId]),
      servers: [
        {
          host: "localhost",
          port: 13773,
          url: "http://localhost:13773",
          processName: "node",
          pid: 102,
          terminal: null,
          agent: { threadId: memberThreadId },
        },
        {
          host: "localhost",
          port: 5733,
          url: "http://localhost:5733",
          processName: "vite",
          pid: 101,
          terminal: { threadId: groupThreadId, terminalId: "default" },
        },
        {
          host: "localhost",
          port: 8080,
          url: "http://localhost:8080",
          processName: "python",
          pid: 103,
          terminal: { threadId: unrelatedThreadId, terminalId: "default" },
        },
      ],
    });

    expect(ports.map((server) => server.port)).toEqual([5733, 13773]);
  });
});
