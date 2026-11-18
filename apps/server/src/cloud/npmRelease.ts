import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL, cliReleaseAssetUrl } from "@t3tools/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);
const decodeMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
      databaseMigration: Schema.Int,
    }),
  ),
);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      // SparkCode publishes a stable GitHub release. Other tracks have no fork release metadata.
      if (spec === "nightly") return null;
      const file = "sparkcode-release.json";
      const url =
        spec === "latest"
          ? `${CLI_RELEASES_PAGE_URL}/latest/download/${file}`
          : cliReleaseAssetUrl(spec, file);
      const unavailable = new ServerNpmReleaseError({
        reason: "Could not read the SparkCode release on GitHub.",
      });
      return yield* Effect.gen(function* () {
        const response = yield* http.get(url);
        if (response.status === 404) return null;
        if (response.status !== 200) return yield* unavailable;
        const release = yield* decodeMetadata(yield* response.text);
        if (spec !== "latest" && spec !== release.version) return yield* unavailable;
        return release;
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => unavailable),
      );
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
