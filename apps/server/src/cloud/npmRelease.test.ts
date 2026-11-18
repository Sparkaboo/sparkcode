import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as NpmRelease from "./npmRelease.ts";

it.effect("reads the SparkCode version and migration head from the matching release asset", () =>
  Effect.gen(function* () {
    const urls: URL[] = [];
    const metadata = { version: "1.2.0", databaseMigration: 42 };
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      urls.push(url);
      const response = url.pathname.includes("/v9.9.9/")
        ? new Response("", { status: 404 })
        : Response.json(metadata);
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const service = yield* NpmRelease.make().pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    expect(yield* service.get({ spec: "latest" })).toEqual(metadata);
    expect(yield* service.get({ spec: "1.2.0" })).toEqual(metadata);
    expect(yield* service.get({ spec: "9.9.9" })).toBeNull();
    expect(yield* service.get({ spec: "nightly" })).toBeNull();
    yield* Effect.flip(service.get({ spec: "1.2.1" }));
    yield* Effect.flip(service.get({ spec: "../other" }));
    expect(urls.map(String)).toEqual(
      ["latest/download", "download/v1.2.0", "download/v9.9.9", "download/v1.2.1"].map(
        (path) => `https://github.com/Sparkaboo/sparkcode/releases/${path}/sparkcode-release.json`,
      ),
    );
  }),
);
