import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { cleanAntigravityEnvironment } from "./antigravityAuthSupport.ts";

export const NativeQuotaRequested = Context.Reference<boolean>(
  "t3/antigravity/NativeQuotaRequested",
  {
    defaultValue: () => false,
  },
);

const decodeReport = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literal("SUCCESS"),
      num_turns: Schema.Literal(0),
      command: Schema.Struct({
        name: Schema.Literal("usage"),
        data: Schema.Struct({
          groups: Schema.Array(
            Schema.Struct({
              name: Schema.optional(Schema.String),
              buckets: Schema.Array(
                Schema.Struct({
                  id: Schema.NonEmptyString,
                  name: Schema.optional(Schema.String),
                  description: Schema.optional(Schema.String),
                  window: Schema.optional(Schema.String),
                  remaining_fraction: Schema.optional(Schema.Number),
                  reset_time: Schema.optional(Schema.String),
                  disabled: Schema.optional(Schema.Boolean),
                }),
              ),
            }),
          ),
        }),
      }),
    }),
  ),
);

const accountInLog = Effect.fn("AntigravityQuota.accountInLog")(function* (log: string) {
  const fs = yield* FileSystem.FileSystem;
  // The native runtime logs its authenticated account at startup; bound reads on long-lived sessions.
  const { text } = yield* collectUint8StreamText({
    stream: fs.stream(log, { bytesToRead: 64 * 1024 }),
  });
  return /^I\d{4}\s+[\d:.]+\s+\d+\s+server_oauth\.go:\d+\] OAuth: authenticated successfully as ([^\s@]+@[^\s@]+)\r?\n/m
    .exec(text)?.[1]
    ?.toLowerCase();
});

export const readNativeAntigravityQuota = Effect.fn("AntigravityQuota.readNative")(
  function* (input: {
    readonly profileDirectory: string;
    readonly executablePath: string;
    readonly version: string | null;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const logs = path.join(input.profileDirectory, "antigravity-acp", "log");
    const latest = (yield* fs.readDirectory(logs))
      .filter((name) => /^acp-server-\d{8}_\d{6}-\d+\.log$/.test(name))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .at(-1);
    if (!latest) return undefined;
    const account = yield* accountInLog(path.join(logs, latest));
    if (!account) return undefined;

    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-quota-" });
    const log = path.join(cwd, "quota.log");
    const env = cleanAntigravityEnvironment(input.environment);
    const run = Effect.fn("AntigravityQuota.runCli")(function* (args: string[]) {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.executablePath, args, {
          cwd,
          env: { ...env, GEMINI_HOME: input.profileDirectory, AGY_ADC_AUTH: undefined },
          extendEnv: false,
          stdin: "ignore",
          stderr: "ignore",
          forceKillAfter: "1 second",
        }),
      );
      const [output, code] = yield* Effect.all(
        [collectUint8StreamText({ stream: child.stdout, maxBytes: 256 * 1024 }), child.exitCode],
        { concurrency: "unbounded" },
      );
      return Number(code) === 0 && !output.truncated && !output.invalidUtf8 ? output.text : "";
    });
    // Earlier versions can forward a slash command to the model instead of answering it locally.
    const version = input.version ?? (yield* run(["--version"])).trim();
    if (!satisfiesSemverRange(version, ">=1.1.11")) return undefined;
    const report = yield* run([
      "--print",
      "/usage",
      "--output-format",
      "json",
      "--log-file",
      log,
    ]).pipe(Effect.flatMap(decodeReport));
    // Print mode can select the host CLI account independently of the authenticated ACP instance.
    if ((yield* accountInLog(log)) !== account) return undefined;
    return {
      account,
      groups: report.command.data.groups.map((group) => ({
        displayName: group.name,
        buckets: group.buckets.map((bucket) => ({
          bucketId: bucket.id,
          displayName: bucket.name,
          description: bucket.description,
          window: bucket.window,
          remainingFraction: bucket.remaining_fraction,
          resetTime: bucket.reset_time,
          disabled: bucket.disabled,
        })),
      })),
    };
  },
  Effect.scoped,
  Effect.timeout("25 seconds"),
  Effect.orElseSucceed(() => undefined),
);
