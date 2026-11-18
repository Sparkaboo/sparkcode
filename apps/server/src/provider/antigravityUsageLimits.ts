import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { NativeQuotaRequested, type readNativeAntigravityQuota } from "./antigravityNativeQuota.ts";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

export function antigravityUserAgent(platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;
}

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
// The ACP runtime meters consumer tiers on the daily host and GCP-terms tiers on prod.
// The sign-in method stands in for the tier.
const ENDPOINTS = {
  "oauth-personal": [DAILY_ENDPOINT, PROD_ENDPOINT],
  "oauth-business": [PROD_ENDPOINT, DAILY_ENDPOINT],
};
const GOOGLE_OAUTH_CLIENT_ID_PATTERN = /\b\d{10,}-[a-z0-9]{24,40}\.apps\.googleusercontent\.com\b/g;
const GOOGLE_OAUTH_CLIENT_SECRET_PATTERN = /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g;
const MAX_CLI_BINARY_BYTES = 256n * 1024n * 1024n;
const KEYRING_SERVICES = {
  "oauth-personal": ["jetski-cli", "antigravity"],
  "oauth-business": ["antigravity", "jetski-cli"],
} as const;
const CLI_TOKEN_FILENAMES = {
  "oauth-personal": ["jetski-oauth-token", "antigravity-oauth-token", "ccpa-oauth-token"],
  "oauth-business": ["ccpa-oauth-token", "antigravity-oauth-token", "jetski-oauth-token"],
} as const;
const KEYRING_ACCOUNT = "gemini";
const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";
const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const TokenFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  project_id: Schema.optional(Schema.String),
});
const AcpAuthState = Schema.Struct({
  methodId: Schema.optional(Schema.String),
});
const CliStoredToken = Schema.Struct({
  token: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        access_token: Schema.optional(Schema.String),
        refresh_token: Schema.optional(Schema.String),
        expiry: Schema.optional(Schema.String),
      }),
    ),
  ),
  refresh_token: Schema.optional(Schema.String),
  auth_method: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
});
const LoadCodeAssistResponse = Schema.Struct({
  cloudaicompanionProject: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ id: Schema.optional(Schema.String) })]),
  ),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const UserInfo = Schema.Struct({ id: Schema.NonEmptyString });
const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Summary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const Models = Schema.Struct({
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      modelProvider: Schema.optional(Schema.String),
      quotaInfo: Schema.optional(Quota),
      weeklyQuotaInfo: Schema.optional(Quota),
    }),
  ),
});

const decodeTokenFile = Schema.decodeEffect(Schema.fromJsonString(TokenFile));
const decodeAcpAuthState = Schema.decodeEffect(Schema.fromJsonString(AcpAuthState));
const decodeCliStoredToken = Schema.decodeEffect(Schema.fromJsonString(CliStoredToken));
const decodeLoadCodeAssist = Schema.decodeUnknownEffect(LoadCodeAssistResponse);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);
const decodeSummary = Schema.decodeUnknownEffect(Summary);
const decodeModels = Schema.decodeUnknownEffect(Models);

export function decodeAntigravityKeyringSecret(raw: string): string | undefined {
  let text = raw.trim();
  if (!text) return undefined;
  // macOS `/usr/bin/security -w` hex-encodes secrets containing newlines or non-ASCII bytes.
  if (/^(?:[0-9a-fA-F]{2})+$/u.test(text)) {
    text = Buffer.from(text, "hex").toString("utf8").trim();
  }
  if (text.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    text = Buffer.from(text.slice(GO_KEYRING_BASE64_PREFIX.length), "base64")
      .toString("utf8")
      .trim();
  }
  return text || undefined;
}

function decodeKeyringBytes(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  const encoding = bytes.byteLength >= 2 && bytes[1] === 0 ? "utf-16le" : "utf-8";
  const text = new TextDecoder(encoding).decode(bytes).trim();
  return text || undefined;
}

function matchesCliAuthMethod(
  storedMethod: string | undefined,
  authMethod: "oauth-personal" | "oauth-business",
): boolean {
  const normalized = storedMethod?.trim();
  if (!normalized) return true;
  return authMethod === "oauth-personal"
    ? normalized === "consumer" || normalized === "oauth-personal"
    : normalized === "gcp" || normalized === "oauth-business";
}

export interface AntigravityOAuthClientPair {
  readonly client_id: string;
  readonly client_secret: string;
}

export function extractAntigravityOAuthClientPairs(
  binaryText: string,
): ReadonlyArray<AntigravityOAuthClientPair> {
  const clientIds = [...new Set(binaryText.match(GOOGLE_OAUTH_CLIENT_ID_PATTERN) ?? [])].slice(
    0,
    6,
  );
  const clientSecrets = [
    ...new Set(binaryText.match(GOOGLE_OAUTH_CLIENT_SECRET_PATTERN) ?? []),
  ].slice(0, 6);
  const pairs: AntigravityOAuthClientPair[] = [];
  const seen = new Set<string>();
  const add = (clientId: string | undefined, clientSecret: string | undefined) => {
    if (!clientId || !clientSecret) return;
    const key = `${clientId}\0${clientSecret}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ client_id: clientId, client_secret: clientSecret });
  };
  const diagonalCount = Math.min(clientIds.length, clientSecrets.length);
  for (let index = 0; index < diagonalCount; index += 1) {
    add(clientIds[index], clientSecrets[index]);
  }
  for (const clientId of clientIds) {
    for (const clientSecret of clientSecrets) {
      add(clientId, clientSecret);
    }
  }
  return pairs;
}

type LoadedCredentials =
  | ({ readonly kind: "legacy" } & typeof TokenFile.Type)
  | {
      readonly kind: "cli";
      readonly refresh_token?: string | undefined;
      readonly access_token?: string | undefined;
      readonly expires_at?: number | undefined;
      readonly project_id?: string | undefined;
    };

function resolveCliCredentials(
  stored: typeof CliStoredToken.Type,
  authMethod: "oauth-personal" | "oauth-business",
  fallbackProjectId?: string,
): LoadedCredentials | undefined {
  if (!matchesCliAuthMethod(stored.auth_method, authMethod)) return undefined;
  const refreshToken = (stored.token?.refresh_token ?? stored.refresh_token)?.trim() || undefined;
  const accessToken = stored.token?.access_token?.trim() || undefined;
  if (!refreshToken && !accessToken) return undefined;
  const parsedExpiry = stored.token?.expiry ? Date.parse(stored.token.expiry) : Number.NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : undefined;
  const projectId = stored.project_id?.trim() || fallbackProjectId?.trim();
  return {
    kind: "cli",
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(accessToken ? { access_token: accessToken } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
}

function extractCompanionProject(response: typeof LoadCodeAssistResponse.Type): string | undefined {
  const value = response.cloudaicompanionProject;
  const raw = typeof value === "string" ? value : value?.id;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

class AntigravityKeyringReadError extends Schema.TaggedError<
  AntigravityKeyringReadError,
  { readonly brand: unique symbol }
>()("AntigravityKeyringReadError", { cause: Schema.Defect() }) {}

const readSystemKeyringSecret = Effect.fn("AntigravityUsageProbe.readSystemKeyringSecret")(
  function* (
    platform: NodeJS.Platform,
    spawner: Option.Option<ChildProcessSpawner.ChildProcessSpawner["Service"]>,
    service: string,
  ) {
    if (platform === "darwin") {
      // `zalando/go-keyring` creates the macOS item via `/usr/bin/security`, which owns its ACL;
      // reading through `/usr/bin/security` avoids triggering a per-app Keychain modal prompt.
      if (Option.isNone(spawner)) return undefined;
      return yield* spawner.value
        .string(
          ChildProcess.make(
            "/usr/bin/security",
            ["find-generic-password", "-s", service, "-a", KEYRING_ACCOUNT, "-w"],
            { stdin: "ignore", stderr: "ignore" },
          ),
        )
        .pipe(
          Effect.timeout("5 seconds"),
          Effect.orElseSucceed(() => undefined),
        );
    }
    if (platform === "win32" || platform === "linux") {
      return yield* Effect.tryPromise({
        try: async () => {
          const Keyring = await import("@napi-rs/keyring");
          if (platform === "win32") {
            // `zalando/go-keyring` names Windows Generic Credentials `<service>:<user>`.
            try {
              const targeted = await Keyring.AsyncEntry.withTarget(
                `${service}:${KEYRING_ACCOUNT}`,
                service,
                KEYRING_ACCOUNT,
              ).getSecret();
              const decoded = decodeKeyringBytes(targeted);
              if (decoded !== undefined) return decoded;
            } catch {
              // Fall back to the default entry lookup below.
            }
          }
          const secret = await new Keyring.AsyncEntry(service, KEYRING_ACCOUNT).getSecret();
          return decodeKeyringBytes(secret);
        },
        catch: (cause) => new AntigravityKeyringReadError({ cause }),
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => undefined),
      );
    }
    return undefined;
  },
);

function iso(value: string | undefined): string | undefined {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function quotaWindow(
  id: string,
  label: string,
  quota: typeof Quota.Type,
  kind: ServerProviderUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): ServerProviderUsageWindow | undefined {
  if (quota.remainingFraction === undefined || !Number.isFinite(quota.remainingFraction)) {
    return undefined;
  }
  const resetsAt = iso(quota.resetTime);
  return {
    id,
    label,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, quota.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(
  bucket: typeof Bucket.Type,
  windowDurationMins: number | undefined,
  requestedAt: number,
): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched =
    bucket.remainingFraction === 1 &&
    bucket.description === undefined &&
    windowDurationMins !== undefined &&
    Math.abs(Date.parse(bucket.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <=
      60_000;
  return untouched ? undefined : bucket.resetTime;
}

const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* (yield* Digest.Digest).digest(
    Digest.sha256,
    new TextEncoder().encode(text),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

/** Keys an account by its Google ID, which matches across machines and hubs; refresh tokens do not. */
export const antigravityAccountFingerprint = (userInfo: unknown) =>
  decodeUserInfo(userInfo).pipe(Effect.flatMap((info) => sha256(`google-account\0${info.id}`)));

/** Windows from a `retrieveUserQuotaSummary` answer requested at `requestedAt`. */
export const antigravitySummaryWindows = (response: unknown, requestedAt: number) =>
  decodeSummary(response).pipe(Effect.map((summary) => summaryWindows(summary, requestedAt)));

function summaryWindows(summary: typeof Summary.Type, requestedAt: number) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? summary.groups
    : [{ buckets: summary.buckets }];
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled) continue;
      // Argon and Carbon are metered separately from the default Gemini buckets.
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : bucket.bucketId.startsWith("gemini-carbon-")
          ? group.displayName?.trim() || "Gemini Carbon"
          : bucket.bucketId.startsWith("gemini-")
            ? "Gemini"
            : bucket.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : group.displayName?.trim() || bucket.bucketId;
      const weekly = bucket.window === "weekly";
      const session = bucket.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(bucket.window ?? "");
      const window = quotaWindow(
        bucket.bucketId,
        `${family} · ${weekly ? "Weekly" : session ? "5-hour" : bucket.displayName?.trim() || "Quota"}`,
        { ...bucket, resetTime: summaryResetTime(bucket, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
function modelWindows(models: typeof Models.Type) {
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [modelId, model] of Object.entries(models.models)) {
    const family =
      model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
        ? "Gemini"
        : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
          ? "Claude"
          : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
            ? "GPT"
            : undefined;
    if (!family) continue;
    for (const [suffix, quota] of [
      ["quota", model.quotaInfo],
      ["weekly", model.weeklyQuotaInfo],
    ] as const) {
      if (!quota) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        `${family} · ${suffix === "weekly" ? "Weekly" : "Reported quota"}`,
        quota,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

export interface AntigravityUsageRuntimeInfo {
  readonly executablePath?: string | undefined;
  readonly usesLegacyTokenFile: boolean;
}

class AntigravityOAuthRefreshError extends Schema.TaggedError<
  AntigravityOAuthRefreshError,
  { readonly brand: unique symbol }
>()("AntigravityOAuthRefreshError", { detail: Schema.String }) {}

const binaryOAuthPairCache = new Map<
  string,
  { readonly cacheKey: string; readonly pairs: ReadonlyArray<AntigravityOAuthClientPair> }
>();

export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* (input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly gcpProject?: string | undefined;
  readonly resolveRuntime?: Effect.Effect<AntigravityUsageRuntimeInfo | undefined> | undefined;
  readonly readKeyring?: ((service: string) => Effect.Effect<string | undefined>) | undefined;
  readonly readNativeQuota?: Effect.Effect<
    Effect.Success<ReturnType<typeof readNativeAntigravityQuota>>
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const crypto = yield* Digest.Digest;
  const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
  const legacyTokenPath = path.join(acpDirectory, "acp_token.json");
  const authStatePath = path.join(acpDirectory, "cache", "acp-auth-state.json");
  const resolveRuntime: Effect.Effect<AntigravityUsageRuntimeInfo | undefined> =
    input.resolveRuntime ?? Effect.succeed({ usesLegacyTokenFile: true });
  const readKeyring =
    input.readKeyring ?? ((service: string) => readSystemKeyringSecret(platform, spawner, service));
  const preferredPairByMethod = new Map<
    "oauth-personal" | "oauth-business",
    AntigravityOAuthClientPair
  >();
  let cached:
    | {
        fingerprint: string;
        account: string;
        accessToken: string;
        expiresAt: number;
        projectsByEndpoint: Map<string, string | undefined>;
      }
    | undefined;
  let generation = 0;

  const request = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("10 seconds"),
    );

  const loadCliOAuthPairs = Effect.fn("AntigravityUsageProbe.loadCliOAuthPairs")(function* (
    executablePath: string | undefined,
    authMethod: "oauth-personal" | "oauth-business",
  ) {
    if (!executablePath || !(yield* fs.exists(executablePath))) return [];
    const info = yield* fs.stat(executablePath).pipe(Effect.orElseSucceed(() => undefined));
    if (!info || info.type !== "File" || info.size > MAX_CLI_BINARY_BYTES) return [];
    const mtimeKey = Option.isSome(info.mtime) ? String(info.mtime.value.getTime()) : "";
    const cacheKey = `${info.size}\0${mtimeKey}`;
    let extracted = binaryOAuthPairCache.get(executablePath);
    if (extracted?.cacheKey !== cacheKey) {
      const bytes = yield* fs
        .readFile(executablePath)
        .pipe(Effect.orElseSucceed(() => new Uint8Array()));
      const pairs =
        bytes.byteLength > 0
          ? extractAntigravityOAuthClientPairs(Buffer.from(bytes).toString("latin1"))
          : [];
      extracted = { cacheKey, pairs };
      if (pairs.length > 0) {
        binaryOAuthPairCache.set(executablePath, extracted);
      }
    }
    const preferred = preferredPairByMethod.get(authMethod);
    if (!preferred) return extracted.pairs;
    return [
      preferred,
      ...extracted.pairs.filter(
        (pair) =>
          pair.client_id !== preferred.client_id || pair.client_secret !== preferred.client_secret,
      ),
    ];
  });

  const loadToken = Effect.fn("AntigravityUsageProbe.loadToken")(function* (
    authMethod: "oauth-personal" | "oauth-business",
    usesLegacyTokenFile: boolean,
    consultSharedKeyring: boolean,
  ) {
    const cliFileStored: Array<typeof CliStoredToken.Type> = [];
    for (const filename of CLI_TOKEN_FILENAMES[authMethod]) {
      const candidatePath = path.join(acpDirectory, filename);
      if (!(yield* fs.exists(candidatePath))) continue;
      const parsed = yield* fs.readFileString(candidatePath).pipe(
        Effect.flatMap(decodeCliStoredToken),
        Effect.orElseSucceed(() => undefined),
      );
      if (parsed && matchesCliAuthMethod(parsed.auth_method, authMethod)) {
        cliFileStored.push(parsed);
      }
    }
    const fallbackProjectId = cliFileStored.find((entry) => entry.project_id?.trim())?.project_id;
    // Prefer profile-local CLI token files before consulting the shared OS keyring.
    for (const stored of cliFileStored) {
      const fromCliFile = resolveCliCredentials(stored, authMethod, fallbackProjectId);
      if (fromCliFile) return fromCliFile;
    }
    // Only consult the shared OS keyring when this ACP profile recorded a matching sign-in.
    if (consultSharedKeyring) {
      for (const service of KEYRING_SERVICES[authMethod]) {
        const keyringRaw = yield* readKeyring(service);
        const decodedKeyring = keyringRaw ? decodeAntigravityKeyringSecret(keyringRaw) : undefined;
        const keyringStored = decodedKeyring
          ? yield* decodeCliStoredToken(decodedKeyring).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        const fromKeyring = keyringStored
          ? resolveCliCredentials(keyringStored, authMethod, fallbackProjectId)
          : undefined;
        if (fromKeyring) return fromKeyring;
      }
    }
    if (usesLegacyTokenFile && (yield* fs.exists(legacyTokenPath))) {
      return yield* fs.readFileString(legacyTokenPath).pipe(
        Effect.flatMap(decodeTokenFile),
        Effect.map((legacy): LoadedCredentials => ({ kind: "legacy", ...legacy })),
        Effect.orElseSucceed(() => undefined),
      );
    }
    return undefined;
  });

  const refreshAccessToken = Effect.fn("AntigravityUsageProbe.refreshAccessToken")(function* (
    token: LoadedCredentials,
    authMethod: "oauth-personal" | "oauth-business",
    executablePath: string | undefined,
    now: number,
  ) {
    const refreshWithPair = (pair: AntigravityOAuthClientPair, refreshToken: string) =>
      request(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: pair.client_id,
            client_secret: pair.client_secret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }),
        ),
      ).pipe(Effect.flatMap(decodeTokenResponse));

    if (token.kind === "legacy") {
      const refreshed = yield* refreshWithPair(token, token.refresh_token);
      return {
        accessToken: refreshed.access_token,
        expiresAt: now + refreshed.expires_in * 1000,
      };
    }
    if (
      token.access_token !== undefined &&
      token.expires_at !== undefined &&
      token.expires_at > now + 60_000
    ) {
      return {
        accessToken: token.access_token,
        expiresAt: token.expires_at,
      };
    }
    if (!token.refresh_token) {
      return yield* new AntigravityOAuthRefreshError({
        detail: "Missing Antigravity refresh token.",
      });
    }
    const pairs = yield* loadCliOAuthPairs(executablePath, authMethod);
    for (const pair of pairs) {
      const refreshed = yield* refreshWithPair(pair, token.refresh_token).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (refreshed) {
        preferredPairByMethod.set(authMethod, pair);
        return {
          accessToken: refreshed.access_token,
          expiresAt: now + refreshed.expires_in * 1000,
        };
      }
    }
    return yield* new AntigravityOAuthRefreshError({
      detail: "Could not refresh Antigravity OAuth token.",
    });
  });

  const read = Effect.gen(function* () {
    const startedGeneration = generation;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const authMethod = input.authMethod;
    const runtime = yield* resolveRuntime;
    const persistedMethod = yield* fs.readFileString(authStatePath).pipe(
      Effect.flatMap(decodeAcpAuthState),
      Effect.map((state) => state.methodId?.trim()),
      Effect.orElseSucceed(() => undefined),
    );
    const hasProfileSignIn = persistedMethod === authMethod || persistedMethod === "terminal-login";
    const nativeQuota =
      runtime?.usesLegacyTokenFile === false && authMethod === "oauth-personal"
        ? input.readNativeQuota
        : undefined;
    const token = yield* loadToken(
      authMethod,
      runtime?.usesLegacyTokenFile ?? false,
      hasProfileSignIn && nativeQuota === undefined,
    );
    if (!token) {
      cached = undefined;
      if (hasProfileSignIn) {
        if (nativeQuota && (yield* NativeQuotaRequested)) {
          const requestedAt = yield* Clock.currentTimeMillis;
          const report = yield* nativeQuota;
          if (report) {
            const windows = summaryWindows(report, requestedAt);
            if (windows.length > 0)
              return {
                ...makeUsageLimits({ checkedAt, windows }),
                credentialFingerprint: yield* sha256(`google-email\0${report.account}`),
              };
          }
        }
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message:
            "Could not read limits for this Antigravity account. Refresh provider status to retry.",
        });
      }
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message:
          "Antigravity limits are unavailable for this profile. Check the account in provider settings.",
      });
    }
    const configuredProject =
      (authMethod === "oauth-business" ? input.gcpProject?.trim() : undefined) ||
      token.project_id?.trim() ||
      undefined;
    const fingerprint = yield* sha256(
      token.kind === "legacy"
        ? `legacy\0${token.client_id}\0${token.refresh_token}\0${configuredProject ?? ""}`
        : `cli\0${authMethod}\0${token.refresh_token ?? token.access_token ?? ""}\0${configuredProject ?? ""}`,
    );
    const now = yield* Clock.currentTimeMillis;
    let accessToken: string;
    let account: string;
    let projectsByEndpoint: Map<string, string | undefined>;
    if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now + 60_000) {
      cached = undefined;
      const refreshed = yield* refreshAccessToken(token, authMethod, runtime?.executablePath, now);
      accessToken = refreshed.accessToken;
      // Use Google account IDs to merge accounts across environments; refresh tokens differ per machine.
      account = yield* request(
        HttpClientRequest.get("https://www.googleapis.com/oauth2/v2/userinfo").pipe(
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${accessToken}` }),
        ),
      ).pipe(
        Effect.flatMap(antigravityAccountFingerprint),
        Effect.orElseSucceed(() => fingerprint),
      );
      projectsByEndpoint = new Map();
      if (generation === startedGeneration) {
        cached = {
          fingerprint,
          account,
          accessToken,
          expiresAt: refreshed.expiresAt,
          projectsByEndpoint,
        };
      }
    } else {
      accessToken = cached.accessToken;
      account = cached.account;
      projectsByEndpoint = cached.projectsByEndpoint;
    }
    const endpoints = ENDPOINTS[authMethod];
    const resolveEndpointProject = Effect.fn("AntigravityUsageProbe.resolveEndpointProject")(
      function* (endpoint: string) {
        if (configuredProject !== undefined) return configuredProject;
        if (projectsByEndpoint.has(endpoint)) return projectsByEndpoint.get(endpoint);
        const resolved = yield* request(
          HttpClientRequest.post(`${endpoint}/v1internal:loadCodeAssist`).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": antigravityUserAgent(platform, architecture),
            }),
            HttpClientRequest.bodyJsonUnsafe({ metadata: { ideType: "ANTIGRAVITY" } }),
          ),
        ).pipe(
          Effect.flatMap(decodeLoadCodeAssist),
          Effect.map((response) => ({
            ok: true as const,
            project: extractCompanionProject(response),
          })),
          Effect.orElseSucceed(() => ({ ok: false as const, project: undefined })),
        );
        if (resolved.ok && generation === startedGeneration) {
          projectsByEndpoint.set(endpoint, resolved.project);
        }
        return resolved.project;
      },
    );
    // Merge endpoints because quota groups differ; the metered host's reading of a bucket wins.
    const fetchWindows = Effect.fn("AntigravityUsageProbe.fetchWindows")(function* <E>(
      operation: string,
      parse: (
        response: unknown,
        requestedAt: number,
      ) => Effect.Effect<ServerProviderUsageWindow[], E>,
    ) {
      const responses = yield* Effect.forEach(
        endpoints,
        (endpoint) =>
          Effect.gen(function* () {
            const project = yield* resolveEndpointProject(endpoint);
            // Capture each request after auth, so refresh latency does not widen the tolerance.
            const requestedAt = yield* Clock.currentTimeMillis;
            return yield* request(
              HttpClientRequest.post(`${endpoint}/v1internal:${operation}`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${accessToken}`,
                  "User-Agent": antigravityUserAgent(platform, architecture),
                }),
                HttpClientRequest.bodyJsonUnsafe(project ? { project } : {}),
              ),
            ).pipe(
              Effect.flatMap((response) => parse(response, requestedAt)),
              Effect.orElseSucceed(() => []),
            );
          }),
        { concurrency: "unbounded" },
      );
      const windows = new Map<string, ServerProviderUsageWindow>();
      for (const window of responses.flat()) {
        if (!windows.has(window.id)) windows.set(window.id, window);
      }
      return [...windows.values()];
    });
    const summary = yield* fetchWindows("retrieveUserQuotaSummary", antigravitySummaryWindows);
    const windows = summary.length
      ? summary
      : yield* fetchWindows("fetchAvailableModels", (response) =>
          decodeModels(response).pipe(Effect.map(modelWindows)),
        );
    if (windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity did not return usable quota information.",
      });
    }
    return { ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint: account };
  });
  const probe = read.pipe(
    Effect.provideService(Digest.Digest, crypto),
    Effect.timeout("30 seconds"),
    Effect.catch(() =>
      Effect.gen(function* () {
        return makeUnavailableUsageLimits({
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          reason: "probeFailed",
          message: "Could not read Antigravity limits. Refresh provider status to retry.",
        });
      }),
    ),
  );
  return {
    probe,
    clear: Effect.sync(() => {
      cached = undefined;
      generation++;
    }),
  };
});
