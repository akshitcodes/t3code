import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { WebPortInspector } from "./process/Services/WebPortInspector";
import { WebPortInspectorLive } from "./process/Layers/WebPortInspector";

const closeServer = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => {
      resume(Effect.void);
    });

    return Effect.sync(() => {
      try {
        server.close();
      } catch {
        // Ignore cleanup failures in tests.
      }
    });
  });

const listenServer = (server: Server) =>
  Effect.callback<number, Error>((resume) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        resume(Effect.fail(error));
        return;
      }

      const address = server.address();
      if (!address || typeof address !== "object") {
        resume(Effect.fail(new Error("Server did not provide a valid listening address.")));
        return;
      }

      resume(Effect.succeed(address.port));
    });

    return closeServer(server);
  });

const startServer = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Effect.Effect<{ server: Server; port: number }, Error> =>
  Effect.gen(function* () {
    const server = createServer(handler);
    const port = yield* listenServer(server);
    return { server, port };
  });

it.layer(WebPortInspectorLive)("WebPortInspectorLive", (it) => {
  it.effect("treats slow HTML responses as web ports", () =>
    Effect.acquireUseRelease(
      startServer((_request, response) => {
        setTimeout(() => {
          response.statusCode = 200;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(
            "<!DOCTYPE html><html><head><title>ok</title></head><body>hello</body></html>",
          );
        }, 800);
      }),
      ({ port }) =>
        Effect.gen(function* () {
          const inspector = yield* WebPortInspector;
          const isWeb = yield* inspector.inspect(port);
          assert.equal(isWeb, true);
        }),
      ({ server }) => closeServer(server),
    ),
  );

  it.effect("treats HTML responses with large bodies as web ports", () =>
    Effect.acquireUseRelease(
      startServer((_request, response) => {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<!DOCTYPE html><html><head><title>x</title></head><body>${"x".repeat(20_000)}</body></html>`,
        );
      }),
      ({ port }) =>
        Effect.gen(function* () {
          const inspector = yield* WebPortInspector;
          const isWeb = yield* inspector.inspect(port);
          assert.equal(isWeb, true);
        }),
      ({ server }) => closeServer(server),
    ),
  );

  it.effect("ignores HTTP 404 responses", () =>
    Effect.acquireUseRelease(
      startServer((_request, response) => {
        response.statusCode = 404;
        response.end();
      }),
      ({ port }) =>
        Effect.gen(function* () {
          const inspector = yield* WebPortInspector;
          const isWeb = yield* inspector.inspect(port);
          assert.equal(isWeb, false);
        }),
      ({ server }) => closeServer(server),
    ),
  );
});
