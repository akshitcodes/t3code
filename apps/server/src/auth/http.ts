import { AuthBootstrapInput } from "@t3tools/contracts";
import { DateTime, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "./Services/ServerAuth.ts";

export const toUnauthorizedResponse = (error: AuthError) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: error.message,
    },
    { status: 401 },
  );

export const authSessionRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.getSessionState(request);
    return HttpServerResponse.jsonUnsafe(session, { status: 200 });
  }),
);

export const authBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const descriptor = yield* serverAuth.getDescriptor();
    const payload = yield* request.json.pipe(
      Effect.flatMap((body) => Schema.decodeUnknownEffect(AuthBootstrapInput)(body)),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredential(payload.credential);

    return yield* HttpServerResponse.jsonUnsafe(result, { status: 200 }).pipe(
      HttpServerResponse.setCookie(descriptor.sessionCookieName, result.sessionToken, {
        expires: DateTime.toDate(result.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(toUnauthorizedResponse(error)))),
);
