import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

import { Effect, Layer } from "effect";

import { WebPortInspectionError } from "../Errors";
import type { WebPortInspectorShape } from "../Services/WebPortInspector";
import { WebPortInspector } from "../Services/WebPortInspector";

const DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS = 2_000;
const WEB_PORT_PROBE_MAX_BODY_BYTES = 8_192;

interface WebProbeResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location: string;
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function isLikelyWebProbe(result: WebProbeResult | null): boolean {
  if (!result) return false;
  if (result.status === 404) return false;
  if (result.status >= 300 && result.status < 400 && result.location.length > 0) {
    return true;
  }
  const contentType = result.contentType.toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }
  const body = result.body.toLowerCase();
  return body.includes("<!doctype") || body.includes("<html") || body.includes("<head");
}

const probeWebPortOnHost = Effect.fn("process.probeWebPortOnHost")(function* (
  port: number,
  host: string,
): Effect.fn.Return<WebProbeResult | null, WebPortInspectionError> {
  return yield* Effect.callback<WebProbeResult | null, WebPortInspectionError>((resume) => {
    let response: IncomingMessage | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const settle = (effect: Effect.Effect<WebProbeResult | null, WebPortInspectionError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      response?.removeAllListeners();
      request.removeAllListeners();
      response?.destroy();
      request.destroy();
    };

    const request = httpRequest(
      {
        host,
        port,
        method: "GET",
        path: "/",
        timeout: DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS,
      },
      (res) => {
        response = res;
        const status = res.statusCode ?? 0;
        const contentType = normalizeHeaderValue(res.headers["content-type"]);
        const location = normalizeHeaderValue(res.headers.location);

        if (
          (status >= 300 && status < 400 && location.length > 0) ||
          contentType.toLowerCase().includes("text/html") ||
          contentType.toLowerCase().includes("application/xhtml+xml")
        ) {
          settle(
            Effect.succeed({
              status,
              contentType,
              location,
              body: "",
            } satisfies WebProbeResult),
          );
          return;
        }

        const chunks: string[] = [];
        let received = 0;

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (received >= WEB_PORT_PROBE_MAX_BODY_BYTES) return;
          const remaining = WEB_PORT_PROBE_MAX_BODY_BYTES - received;
          const fragment = chunk.slice(0, remaining);
          received += fragment.length;
          chunks.push(fragment);
          if (received >= WEB_PORT_PROBE_MAX_BODY_BYTES) {
            settle(
              Effect.succeed({
                status,
                contentType,
                location,
                body: chunks.join(""),
              } satisfies WebProbeResult),
            );
          }
        });
        res.on("end", () => {
          settle(
            Effect.succeed({
              status,
              contentType,
              location,
              body: chunks.join(""),
            } satisfies WebProbeResult),
          );
        });
        res.on("error", (cause) => {
          settle(
            Effect.fail(
              new WebPortInspectionError({
                port,
                host,
                detail: "Failed to read HTTP probe response.",
                cause,
              }),
            ),
          );
        });
      },
    );

    request.on("timeout", () => {
      settle(
        Effect.fail(
          new WebPortInspectionError({
            port,
            host,
            detail: "HTTP probe timed out.",
          }),
        ),
      );
    });
    request.on("error", (cause) => {
      settle(
        Effect.fail(
          new WebPortInspectionError({
            port,
            host,
            detail: "Failed to open HTTP probe request.",
            cause,
          }),
        ),
      );
    });

    timer = setTimeout(() => {
      settle(
        Effect.fail(
          new WebPortInspectionError({
            port,
            host,
            detail: "HTTP probe timed out.",
          }),
        ),
      );
    }, DEFAULT_WEB_PORT_PROBE_TIMEOUT_MS + 50);

    request.end();

    return Effect.sync(cleanup);
  });
});

const makeWebPortInspector = Effect.succeed({
  inspect: Effect.fn("process.inspectWebPort")(function* (port) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return yield* new WebPortInspectionError({
        port,
        host: "127.0.0.1",
        detail: "Port must be an integer between 1 and 65535.",
      });
    }

    const ipv4Result = yield* probeWebPortOnHost(port, "127.0.0.1").pipe(Effect.exit);
    if (ipv4Result._tag === "Success" && isLikelyWebProbe(ipv4Result.value)) {
      return true;
    }

    const ipv6Result = yield* probeWebPortOnHost(port, "::1").pipe(Effect.exit);
    if (ipv6Result._tag === "Success" && isLikelyWebProbe(ipv6Result.value)) {
      return true;
    }

    if (ipv4Result._tag === "Success" || ipv6Result._tag === "Success") {
      return false;
    }

    if (ipv6Result._tag === "Failure") {
      return yield* Effect.failCause(ipv6Result.cause);
    }

    return yield* Effect.failCause(ipv4Result.cause);
  }),
} satisfies WebPortInspectorShape);

export const WebPortInspectorLive = Layer.effect(WebPortInspector, makeWebPortInspector);
