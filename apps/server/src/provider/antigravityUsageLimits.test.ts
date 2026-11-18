import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import {
  type AntigravityUsageRuntimeInfo,
  decodeAntigravityKeyringSecret,
  extractAntigravityOAuthClientPairs,
  makeAntigravityUsageProbe,
} from "./antigravityUsageLimits.ts";
import { NativeQuotaRequested, readNativeAntigravityQuota } from "./antigravityNativeQuota.ts";

const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.96,
          resetTime: "2026-10-12T19:41:43Z",
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.91,
          resetTime: "2026-10-09T16:06:01Z",
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          remainingFraction: 0,
          resetTime: "2026-10-10T15:28:22Z",
        },
        {
          bucketId: "3p-5h",
          window: "5h",
          remainingFraction: 0.44,
          resetTime: "2026-10-09T16:06:30Z",
        },
      ],
    },
  ],
};

const fixture = Effect.fn("AntigravityUsageTest.fixture")(function* (
  options: {
    summary?: unknown;
    /** Per-host quota summaries; hosts not listed fall back to `summary`. */
    summaryByHost?: Record<string, unknown>;
    models?: unknown;
    summaryStatus?: number;
    /** Per-host summary statuses; hosts not listed fall back to `summaryStatus`. */
    summaryStatusByHost?: Record<string, number>;
    tokenStatus?: number;
    refreshToken?: string;
    userId?: string;
    userInfoAt?: number;
    missingToken?: boolean;
    nativeQuota?: boolean;
    authMethod?: "oauth-personal" | "oauth-business" | "gemini-api-key";
    gcpProject?: string;
    resolveRuntime?: Effect.Effect<AntigravityUsageRuntimeInfo | undefined>;
    loadCodeAssistByHost?: Record<string, unknown>;
    loadCodeAssistStatusByHost?: Record<string, number>;
    expectedProjectByHost?: Record<string, string | undefined>;
    readKeyring?: (service: string) => Effect.Effect<string | undefined>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileDirectory = yield* fs.makeTempDirectoryScoped();
  const acpDirectory = path.join(profileDirectory, "antigravity-acp");
  yield* fs.makeDirectory(acpDirectory);
  const cliBinaryPath = path.join(profileDirectory, "fake-antigravity-cli");
  const syntheticClientId = `${"1".repeat(12)}-${"a".repeat(32)}.apps.googleusercontent.com`;
  const syntheticClientSecret = `${"GOCSPX"}-${"x".repeat(28)}`;
  yield* fs.writeFileString(
    cliBinaryPath,
    `rodata:${syntheticClientId}\0${syntheticClientSecret}\n`,
  );
  const tokenPath = path.join(acpDirectory, "acp_token.json");
  const cliTokenPath = path.join(acpDirectory, "jetski-oauth-token");
  const authStatePath = path.join(acpDirectory, "cache", "acp-auth-state.json");
  const writeToken = (refreshToken: string) =>
    fs.writeFileString(
      tokenPath,
      JSON.stringify({
        client_id: "client-id",
        client_secret: "client-secret",
        refresh_token: refreshToken,
        project_id: "project-id",
      }),
    );
  if (!options.missingToken) yield* writeToken(options.refreshToken ?? "refresh-a");
  const requests: Array<{ url: string; body: string }> = [];
  const http = HttpClient.make((request, url, _signal, fiber) =>
    Effect.sync(() => {
      const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
      expect(init?.redirect).toBe("manual");
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ url: request.url, body });
      if (request.url.endsWith("/token")) {
        expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { access_token: "access-token", expires_in: 3600 },
            { status: options.tokenStatus ?? 200 },
          ),
        );
      }
      expect(request.headers.authorization).toBe("Bearer access-token");
      if (request.url.endsWith("/userinfo")) {
        return HttpClientResponse.fromWeb(
          request,
          options.userId
            ? Response.json({ id: options.userId, email: "someone@example.com" })
            : Response.json({}, { status: 403 }),
        );
      }
      expect(request.headers["user-agent"]).toMatch(/^antigravity\/hub\/2\.24\.0 /);
      if (request.url.endsWith(":loadCodeAssist")) {
        expect(JSON.parse(body)).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            options.loadCodeAssistByHost?.[url.host] ?? {
              cloudaicompanionProject: "companion-project",
            },
            { status: options.loadCodeAssistStatusByHost?.[url.host] ?? 200 },
          ),
        );
      }
      const expectedProject =
        options.expectedProjectByHost && url.host in options.expectedProjectByHost
          ? options.expectedProjectByHost[url.host]
          : "project-id";
      expect(JSON.parse(body)).toEqual(expectedProject ? { project: expectedProject } : {});
      return HttpClientResponse.fromWeb(
        request,
        request.url.endsWith(":retrieveUserQuotaSummary")
          ? Response.json(options.summaryByHost?.[url.host] ?? options.summary ?? summary, {
              status: options.summaryStatusByHost?.[url.host] ?? options.summaryStatus ?? 200,
            })
          : Response.json(options.models ?? { models: {} }),
      );
    }).pipe(
      Effect.tap(() =>
        request.url.endsWith("/userinfo") && options.userInfoAt !== undefined
          ? TestClock.setTime(options.userInfoAt)
          : Effect.void,
      ),
    ),
  );
  const usage = yield* makeAntigravityUsageProbe({
    profileDirectory,
    authMethod: options.authMethod ?? "oauth-personal",
    ...(options.gcpProject === undefined ? {} : { gcpProject: options.gcpProject }),
    resolveRuntime:
      options.resolveRuntime ??
      Effect.succeed({ executablePath: cliBinaryPath, usesLegacyTokenFile: true }),
    ...(options.nativeQuota
      ? {
          readNativeQuota: readNativeAntigravityQuota({
            profileDirectory,
            executablePath: cliBinaryPath,
            version: null,
            environment: {},
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              yield* ChildProcessSpawner.ChildProcessSpawner,
            ),
          ),
        }
      : {}),
    ...(options.readKeyring === undefined ? {} : { readKeyring: options.readKeyring }),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
  return {
    ...usage,
    requests,
    writeToken,
    acpDirectory,
    cliBinaryPath,
    tokenPath,
    cliTokenPath,
    authStatePath,
  };
});

describe("Antigravity subscription limits", () => {
  // Oracle: the 10:16 UTC payload and its narrow Workaround rule.
  it.effect("omits rolling resets for untouched summary buckets and keeps used Gemini resets", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          groups: [
            {
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 1,
                  resetTime: "2026-10-21T15:16:05Z",
                },
                {
                  bucketId: "3p-weekly",
                  window: "weekly",
                  remainingFraction: 1,
                  resetTime: "2026-10-28T10:16:05Z",
                },
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  remainingFraction: 0.848104,
                  resetTime: "2026-10-21T13:29:53Z",
                  description:
                    "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 13 minutes.",
                },
                {
                  bucketId: "gemini-weekly",
                  window: "weekly",
                  remainingFraction: 0.9620177,
                  resetTime: "2026-10-28T08:29:53Z",
                  description:
                    "You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.",
                },
              ],
            },
          ],
        },
      });
      const limits = yield* probe;
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("3p-5h")).toEqual({
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      });
      expect(byId.get("3p-weekly")).toEqual({
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 10080,
      });
      expect(byId.get("gemini-5h")?.resetsAt).toBe("2026-10-21T13:29:53.000Z");
      expect(byId.get("gemini-weekly")?.resetsAt).toBe("2026-10-28T08:29:53.000Z");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: measure the tolerance from the summary request, after auth.
  it.effect("uses summary request time after authentication for the reset tolerance", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:02Z")));
      const { probe } = yield* fixture({
        userInfoAt: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")),
        summary: {
          buckets: [
            {
              bucketId: "3p-5h",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:03Z",
            },
          ],
        },
      });
      expect((yield* probe).windows[0]?.resetsAt).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: keep descriptions, measured resets, and spent buckets.
  it.effect("keeps summary resets with a description, a distant reset, or no quota left", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            {
              bucketId: "described",
              window: "5h",
              remainingFraction: 1,
              description: "Reported reset",
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "distant",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T12:16:04Z",
            },
            {
              bucketId: "spent",
              window: "5h",
              remainingFraction: 0,
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "overfull",
              window: "5h",
              remainingFraction: 1.01,
              resetTime: "2026-10-21T15:16:04Z",
            },
            {
              bucketId: "empty-description",
              window: "5h",
              remainingFraction: 1,
              description: "",
              resetTime: "2026-10-21T15:16:04Z",
            },
          ],
        },
      });
      expect((yield* probe).windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
        { id: "described", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "empty-description", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "overfull", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "spent", resetsAt: "2026-10-21T15:16:04.000Z" },
        { id: "distant", resetsAt: "2026-10-28T12:16:04.000Z" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: the 60-second tolerance applies to both known window lengths.
  it.effect("omits summary resets 59 seconds away but keeps resets 61 seconds away", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            {
              bucketId: "5h-before",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:15:05Z",
            },
            {
              bucketId: "5h-after",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:05Z",
            },
            {
              bucketId: "5h-edge",
              window: "5h",
              remainingFraction: 1,
              resetTime: "2026-10-21T15:17:04Z",
            },
            {
              bucketId: "weekly-after",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:17:03Z",
            },
            {
              bucketId: "weekly-before",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:15:03Z",
            },
            {
              bucketId: "weekly-edge",
              window: "weekly",
              remainingFraction: 1,
              resetTime: "2026-10-28T10:15:04Z",
            },
          ],
        },
      });
      expect((yield* probe).windows.map(({ id, resetsAt }) => ({ id, resetsAt }))).toEqual([
        { id: "5h-after", resetsAt: "2026-10-21T15:17:05.000Z" },
        { id: "5h-before", resetsAt: undefined },
        { id: "5h-edge", resetsAt: undefined },
        { id: "weekly-after", resetsAt: undefined },
        { id: "weekly-before", resetsAt: "2026-10-28T10:15:03.000Z" },
        { id: "weekly-edge", resetsAt: undefined },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: workspace sign-ins are metered on cloudcode-pa, so its reading wins even when less used.
  it.effect("reports a business account's quota from the endpoint it is metered on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        authMethod: "oauth-business",
        summaryByHost: {
          "daily-cloudcode-pa.googleapis.com": {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-10-21T15:16:04Z",
              },
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 0.5,
                resetTime: "2026-10-27T10:16:04Z",
              },
            ],
          },
          "cloudcode-pa.googleapis.com": {
            buckets: [
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 0.5,
                resetTime: "2026-10-21T13:16:04Z",
              },
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 1,
                resetTime: "2026-10-28T10:16:04Z",
              },
            ],
          },
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "3p-5h",
          label: "Claude & GPT (shared) · 5-hour",
          kind: "session",
          usedPercent: 50,
          windowDurationMins: 300,
          resetsAt: "2026-10-21T13:16:04.000Z",
        },
        {
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
          kind: "weekly",
          usedPercent: 0,
          windowDurationMins: 10080,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: model quotas have no evidence for the summary-only rule.
  it.effect("keeps full model fallback resets even at a full window from the request", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:16:04Z")));
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              quotaInfo: { remainingFraction: 1, resetTime: "2026-10-21T15:16:04Z" },
              weeklyQuotaInfo: { remainingFraction: 1, resetTime: "2026-10-28T10:16:04Z" },
            },
          },
        },
      });
      expect(
        (yield* probe).windows.map(({ id, resetsAt, windowDurationMins }) => ({
          id,
          resetsAt,
          windowDurationMins,
        })),
      ).toEqual([
        { id: "gemini-weekly", resetsAt: "2026-10-28T10:16:04.000Z", windowDurationMins: 10080 },
        { id: "gemini-quota", resetsAt: "2026-10-21T15:16:04.000Z", windowDurationMins: undefined },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reports separate Gemini and shared Claude/GPT five-hour and weekly limits", () =>
    Effect.gen(function* () {
      const { probe, requests } = yield* fixture();
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(4);
      expect(limits.unavailable).toBeUndefined();
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.usedPercent).toBeCloseTo(4);
      expect(byId.get("gemini-5h")?.usedPercent).toBeCloseTo(9);
      expect(byId.get("3p-weekly")).toMatchObject({
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-10-10T15:28:22.000Z",
      });
      expect(byId.get("3p-5h")).toMatchObject({ kind: "session", windowDurationMins: 300 });
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(56);
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1);
      expect(
        requests.filter((request) => request.url.endsWith(":retrieveUserQuotaSummary")),
      ).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("merges quota groups that only one endpoint reports", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryByHost: {
          // The daily endpoint can omit Gemini while the other endpoint returns all groups.
          "daily-cloudcode-pa.googleapis.com": {
            groups: [
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.5 },
                  { bucketId: "3p-5h", window: "5h", remainingFraction: 0.3 },
                ],
              },
            ],
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows.map((window) => window.id).toSorted()).toEqual([
        "3p-5h",
        "3p-weekly",
        "gemini-5h",
        "gemini-weekly",
      ]);
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("3p-5h")?.usedPercent).toBeCloseTo(70);
      expect(byId.get("3p-weekly")?.usedPercent).toBe(50);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // Oracle: reported payloads for a personal sign-in, whose runtime meters on the daily endpoint.
  it.effect("reports a personal account's quota from the daily endpoint it is metered on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-07T12:00:00Z")));
      const argon = (remainingFraction: number, resetTime: string) => ({
        groups: [
          {
            displayName: "Gemini 4 Argon",
            buckets: [
              {
                bucketId: "gemini-argon-wtu-weekly",
                window: "weekly",
                remainingFraction,
                resetTime,
              },
            ],
          },
        ],
      });
      const { probe } = yield* fixture({
        authMethod: "oauth-personal",
        summaryByHost: {
          "daily-cloudcode-pa.googleapis.com": argon(0.8623059, "2026-11-14T08:41:35Z"),
          "cloudcode-pa.googleapis.com": argon(0, "2026-11-08T18:27:14Z"),
        },
      });
      expect((yield* probe).windows).toEqual([
        expect.objectContaining({
          id: "gemini-argon-wtu-weekly",
          usedPercent: expect.closeTo(13.77, 2),
          resetsAt: "2026-11-14T08:41:35.000Z",
        }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("labels Argon and Carbon quotas apart from the default Gemini quota", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          groups: [
            ...summary.groups,
            {
              displayName: "Gemini 4 Argon",
              buckets: [
                { bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.6 },
              ],
            },
            {
              displayName: "Gemini 4 Carbon",
              buckets: [
                { bucketId: "gemini-carbon-wtu-weekly", window: "weekly", remainingFraction: 0.4 },
              ],
            },
            {
              displayName: " ",
              buckets: [{ bucketId: "gemini-carbon-5h", window: "5h", remainingFraction: 0.8 }],
            },
          ],
        },
      });
      const limits = yield* probe;
      const byId = new Map(limits.windows.map((window) => [window.id, window]));
      expect(byId.get("gemini-weekly")?.label).toBe("Gemini · Weekly");
      expect(byId.get("gemini-argon-wtu-weekly")?.label).toBe("Gemini 4 Argon · Weekly");
      expect(byId.get("gemini-carbon-wtu-weekly")?.label).toBe("Gemini 4 Carbon · Weekly");
      expect(byId.get("gemini-carbon-5h")?.label).toBe("Gemini Carbon · 5-hour");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("keeps one endpoint's quotas when the other fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatusByHost: { "daily-cloudcode-pa.googleapis.com": 503 },
      });
      const limits = yield* probe;
      expect(limits.unavailable).toBeUndefined();
      expect(limits.windows).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("re-reads changed credentials and clears cached access after sign-out", () =>
    Effect.gen(function* () {
      const { probe, clear, requests, writeToken, tokenPath } = yield* fixture();
      const first = yield* probe;
      yield* writeToken("refresh-b");
      const second = yield* probe;
      expect(second.credentialFingerprint).not.toBe(first.credentialFingerprint);
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(2);
      yield* (yield* FileSystem.FileSystem).remove(tokenPath);
      expect((yield* probe).unavailable?.reason).toBe("unsupported");
      yield* writeToken("refresh-b");
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(3);
      yield* clear;
      yield* probe;
      expect(requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("names one Google account the same way from every sign-in", () =>
    Effect.gen(function* () {
      const read = (refreshToken: string, userId: string) =>
        fixture({ refreshToken, userId }).pipe(Effect.flatMap((usage) => usage.probe));
      const machineA = yield* read("refresh-a", "google-user-1");
      const machineB = yield* read("refresh-b", "google-user-1");
      const otherAccount = yield* read("refresh-c", "google-user-2");
      expect(machineA.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(machineB.credentialFingerprint).toBe(machineA.credentialFingerprint);
      expect(otherAccount.credentialFingerprint).not.toBe(machineA.credentialFingerprint);
      expect(JSON.stringify(machineA)).not.toMatch(/google-user-1|someone@example.com/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("falls back to model quotas without inventing a window duration", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summaryStatus: 404,
        models: {
          models: {
            "gemini-a": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.8, resetTime: "2026-10-10T12:00:00Z" },
            },
            "gemini-b": {
              modelProvider: "MODEL_PROVIDER_GOOGLE",
              quotaInfo: { remainingFraction: 0.6, resetTime: "2026-10-10T12:00:00Z" },
            },
            "claude-a": { quotaInfo: { remainingFraction: 0.2 } },
          },
        },
      });
      const limits = yield* probe;
      expect(limits.windows).toHaveLength(2);
      expect(limits.windows.find((window) => window.id === "gemini-quota")?.usedPercent).toBe(40);
      expect(
        limits.windows.every(
          (window) => window.kind === "other" && window.windowDurationMins === undefined,
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("skips disabled and missing fractions and clamps valid percentages", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({
        summary: {
          buckets: [
            { bucketId: "disabled", remainingFraction: 0, disabled: true },
            { bucketId: "missing", resetTime: "2026-10-10T12:00:00Z" },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 2, resetTime: "invalid" },
          ],
        },
      });
      expect((yield* probe).windows).toEqual([
        {
          id: "gemini-5h",
          kind: "session",
          label: "Gemini · 5-hour",
          usedPercent: 0,
          windowDurationMins: 300,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("returns a safe failure when OAuth refresh fails", () =>
    Effect.gen(function* () {
      const { probe } = yield* fixture({ tokenStatus: 401 });
      const limits = yield* probe;
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(JSON.stringify(limits)).not.toMatch(/client-secret|refresh-a|access-token/);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("does not make network requests for API keys or missing sign-ins", () =>
    Effect.gen(function* () {
      for (const options of [{ authMethod: "gemini-api-key" as const }, { missingToken: true }]) {
        const { probe, requests } = yield* fixture(options);
        expect((yield* probe).unavailable?.reason).toBe("unsupported");
        expect(requests).toEqual([]);
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const native = yield* fixture({
        missingToken: true,
        resolveRuntime: Effect.succeed({ usesLegacyTokenFile: false }),
        readKeyring: () => Effect.undefined,
      });
      yield* fs.makeDirectory(path.dirname(native.authStatePath), { recursive: true });
      yield* fs.writeFileString(
        native.authStatePath,
        JSON.stringify({ methodId: "oauth-personal" }),
      );
      const limits = yield* native.probe;
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(limits.unavailable?.message).not.toMatch(/sign in/i);
      expect(native.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("publishes the signed-in ACP account's zero-turn print quotas only on refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let email = "owner@example.com";
      let version = "1.5.10";
      let turns = 0;
      let calls = 0;
      const login = (account: string) =>
        `I1118 11:55:37.000123 53 server_oauth.go:226] OAuth: authenticated successfully as ${account}\n`;
      const spawner = ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
          let stdout = version;
          if (command.args[0] !== "--version") {
            expect(command.args.slice(0, 5)).toEqual([
              "--print",
              "/usage",
              "--output-format",
              "json",
              "--log-file",
            ]);
            yield* fs.writeFileString(String(command.args[5]), login(email));
            calls++;
            stdout = JSON.stringify({
              status: "SUCCESS",
              num_turns: turns,
              command: {
                name: "usage",
                data: {
                  groups: [
                    {
                      name: "Gemini Models",
                      buckets: [
                        { id: "gemini-5h", window: "5h", remaining_fraction: 0.89 },
                        {
                          id: "gemini-weekly",
                          window: "weekly",
                          remaining_fraction: 0,
                          reset_time: "2026-11-25T01:32:25Z",
                        },
                        { id: "off", disabled: true, remaining_fraction: 1 },
                      ],
                    },
                  ],
                },
              },
            });
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.succeed(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const native = yield* fixture({
        missingToken: true,
        nativeQuota: true,
        readKeyring: () =>
          Effect.die("native print quotas must not read another account from the shared keyring"),
        resolveRuntime: Effect.succeed({ usesLegacyTokenFile: false }),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      yield* fs.makeDirectory(path.dirname(native.authStatePath), { recursive: true });
      yield* fs.writeFileString(
        native.authStatePath,
        JSON.stringify({ methodId: "oauth-personal" }),
      );
      const logDir = path.join(native.acpDirectory, "log");
      yield* fs.makeDirectory(logDir);
      yield* fs.writeFileString(
        path.join(logDir, "acp-server-20261118_115536-123.log"),
        login(email),
      );
      const refresh = native.probe.pipe(Effect.provideService(NativeQuotaRequested, true));
      expect((yield* native.probe).unavailable?.reason).toBe("probeFailed");
      expect(calls).toBe(0);
      const limits = yield* refresh;
      expect(limits.windows.map((w) => [w.id, Math.round(w.usedPercent)])).toEqual([
        ["gemini-5h", 11],
        ["gemini-weekly", 100],
      ]);
      expect(limits.windows[1]?.resetsAt).toBe("2026-11-25T01:32:25.000Z");
      expect(limits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(limits)).not.toContain(email);
      turns = 1;
      expect((yield* refresh).unavailable?.reason).toBe("probeFailed");
      turns = 0;
      email = "other@example.com";
      expect((yield* refresh).windows).toEqual([]);
      version = "1.1.10";
      yield* refresh;
      expect(calls).toBe(3);
      expect(native.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect(
    "reads native agy CLI keyring and file tokens and resolves companion projects per host",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const keyringPayload = JSON.stringify({
          token: { access_token: "stale", refresh_token: "cli-keyring-refresh" },
          auth_method: "consumer",
          id_token_email: "someone@example.com",
        });
        const encodedKeyring = `go-keyring-base64:${Buffer.from(keyringPayload).toString("base64")}`;
        const keyringServicesQueried: string[] = [];
        const loadCodeAssistStatusByHost: Record<string, number> = {
          "daily-cloudcode-pa.googleapis.com": 503,
        };
        const expectedProjectByHost: Record<string, string | undefined> = {
          "daily-cloudcode-pa.googleapis.com": undefined,
          "cloudcode-pa.googleapis.com": "prod-project",
        };
        const cliBinDir = yield* fs.makeTempDirectoryScoped();
        const cliBinPath = path.join(cliBinDir, "cli-bin");
        const cliClientId = `${"2".repeat(12)}-${"b".repeat(32)}.apps.googleusercontent.com`;
        const cliClientSecret = `${"GOCSPX"}-${"y".repeat(28)}`;
        yield* fs.writeFileString(cliBinPath, `${cliClientId}\0${cliClientSecret}`);
        const { probe, requests, cliTokenPath, authStatePath } = yield* fixture({
          userId: "google-user-cli",
          // Leftover enterprise gcpProject must not leak into oauth-personal requests.
          gcpProject: "stale-enterprise-project",
          // Native agy CLI ignores stale 1.4.5 acp_token.json files left behind after migration.
          resolveRuntime: Effect.succeed({
            executablePath: cliBinPath,
            usesLegacyTokenFile: false,
          }),
          loadCodeAssistByHost: {
            "daily-cloudcode-pa.googleapis.com": { cloudaicompanionProject: "daily-project" },
            "cloudcode-pa.googleapis.com": { cloudaicompanionProject: "prod-project" },
          },
          loadCodeAssistStatusByHost,
          expectedProjectByHost,
          readKeyring: (service) =>
            Effect.sync(() => {
              keyringServicesQueried.push(service);
              return service === "jetski-cli" ? encodedKeyring : undefined;
            }),
        });

        // Without persisted ACP auth state or a CLI token file, both keyring and legacy acp_token.json are ignored.
        expect((yield* probe).unavailable?.reason).toBe("unsupported");
        expect(keyringServicesQueried).toEqual([]);
        expect(requests).toEqual([]);

        yield* fs.makeDirectory(path.dirname(authStatePath), { recursive: true });
        yield* fs.writeFileString(authStatePath, JSON.stringify({ methodId: "oauth-personal" }));
        const fromKeyring = yield* probe;
        expect(keyringServicesQueried).toEqual(["jetski-cli"]);
        expect(fromKeyring.unavailable).toBeUndefined();
        expect(fromKeyring.windows).toHaveLength(4);
        expect(JSON.stringify(fromKeyring)).not.toMatch(
          /cli-keyring-refresh|someone@example\.com|google-user-cli/,
        );
        expect(requests.filter((request) => request.url.endsWith(":loadCodeAssist"))).toHaveLength(
          2,
        );

        // Transient loadCodeAssist failure on daily host is retried on the next poll; prod host stays cached.
        delete loadCodeAssistStatusByHost["daily-cloudcode-pa.googleapis.com"];
        expectedProjectByHost["daily-cloudcode-pa.googleapis.com"] = "daily-project";
        yield* probe;
        expect(requests.filter((request) => request.url.endsWith(":loadCodeAssist"))).toHaveLength(
          3,
        );

        // Once both hosts succeed, companion projects stay cached across subsequent polls.
        yield* probe;
        expect(requests.filter((request) => request.url.endsWith(":loadCodeAssist"))).toHaveLength(
          3,
        );

        // Profile-local CLI token files win over the shared OS keyring.
        yield* fs.writeFileString(
          cliTokenPath,
          JSON.stringify({
            token: { refresh_token: "cli-file-refresh" },
            auth_method: "consumer",
          }),
        );
        keyringServicesQueried.length = 0;
        expect((yield* probe).windows).toHaveLength(4);
        expect(keyringServicesQueried).toEqual([]);

        // Sign-out removes acp-auth-state.json and profile token files.
        yield* fs.remove(authStatePath);
        yield* fs.remove(cliTokenPath);
        expect((yield* probe).unavailable?.reason).toBe("unsupported");

        const hexSecret = Buffer.from(`${encodedKeyring}\n`, "utf8").toString("hex");
        expect(decodeAntigravityKeyringSecret(hexSecret)).toBe(keyringPayload);
        const extractedPairs = extractAntigravityOAuthClientPairs(
          `${"3".repeat(12)}-${"c".repeat(32)}.apps.googleusercontent.com|${"GOCSPX"}-${"z".repeat(28)}`,
        );
        expect(extractedPairs).toHaveLength(1);

        // Unexpired access_token in StoredToken skips the OAuth refresh roundtrip entirely.
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-21T10:00:00Z")),
        );
        const freshAccessFixture = yield* fixture({
          missingToken: true,
          resolveRuntime: Effect.succeed({ usesLegacyTokenFile: false }),
          expectedProjectByHost: {
            "daily-cloudcode-pa.googleapis.com": "companion-project",
            "cloudcode-pa.googleapis.com": "companion-project",
          },
        });
        yield* fs.writeFileString(
          freshAccessFixture.cliTokenPath,
          JSON.stringify({
            token: {
              access_token: "access-token",
              expiry: "2026-10-21T10:30:00Z",
            },
            auth_method: "consumer",
          }),
        );
        expect((yield* freshAccessFixture.probe).windows).toHaveLength(4);
        expect(
          freshAccessFixture.requests.filter((request) => request.url.endsWith("/token")),
        ).toEqual([]);

        // ChildProcessSpawner provided at construction is retained when probe runs without it on darwin.
        const baseSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const securityCommands: string[] = [];
        const constructionSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
          ...baseSpawner,
          string: (command) =>
            Effect.sync(() => {
              securityCommands.push(
                command._tag === "StandardCommand"
                  ? `${command.command} ${command.args.join(" ")}`
                  : command._tag,
              );
              return `${hexSecret}\n`;
            }),
        });
        const unprovidedSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
          ...baseSpawner,
          string: () => Effect.die("probe should use construction-time spawner"),
        });
        const darwinFixture = yield* fixture({
          missingToken: true,
          expectedProjectByHost: {
            "daily-cloudcode-pa.googleapis.com": "companion-project",
            "cloudcode-pa.googleapis.com": "companion-project",
          },
        }).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, constructionSpawner),
        );
        yield* fs.makeDirectory(path.dirname(darwinFixture.authStatePath), { recursive: true });
        yield* fs.writeFileString(
          darwinFixture.authStatePath,
          JSON.stringify({ methodId: "oauth-personal" }),
        );
        const darwinLimits = yield* darwinFixture.probe.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unprovidedSpawner),
        );
        expect(darwinLimits.windows).toHaveLength(4);
        expect(securityCommands).toEqual([
          "/usr/bin/security find-generic-password -s jetski-cli -a gemini -w",
        ]);

        const fileFixture = yield* fixture({
          missingToken: true,
          authMethod: "oauth-business",
          gcpProject: "enterprise-project",
          expectedProjectByHost: {
            "daily-cloudcode-pa.googleapis.com": "enterprise-project",
            "cloudcode-pa.googleapis.com": "enterprise-project",
          },
          readKeyring: () => Effect.undefined,
        });
        yield* fs.writeFileString(
          path.join(fileFixture.acpDirectory, "ccpa-oauth-token"),
          JSON.stringify({
            token: { refresh_token: "cli-business-refresh" },
            auth_method: "gcp",
          }),
        );
        const fromFile = yield* fileFixture.probe;
        expect(fromFile.unavailable).toBeUndefined();
        expect(fromFile.windows).toHaveLength(4);
        expect(
          fileFixture.requests.filter((request) => request.url.endsWith(":loadCodeAssist")),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
