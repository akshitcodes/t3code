import { type AuthBootstrapResult, type AuthSessionState } from "@t3tools/contracts";
import { DateTime, Effect, Layer, Option } from "effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { HttpServerRequest as HttpServerRequestModule } from "effect/unstable/http";

import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService.ts";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy.ts";
import { SessionCredentialServiceLive } from "./SessionCredentialService.ts";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService.ts";
import { ServerAuthPolicy } from "../Services/ServerAuthPolicy.ts";
import {
  ServerAuth,
  type AuthenticatedSession,
  AuthError,
  type ServerAuthShape,
} from "../Services/ServerAuth.ts";
import { SessionCredentialService } from "../Services/SessionCredentialService.ts";

const AUTHORIZATION_PREFIX = "Bearer ";

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(AUTHORIZATION_PREFIX)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function parseQueryToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const url = HttpServerRequestModule.toURL(request);
  if (Option.isNone(url)) {
    return null;
  }
  const token = url.value.searchParams.get("token");
  return token && token.length > 0 ? token : null;
}

export const makeServerAuth = Effect.gen(function* () {
  const policy = yield* ServerAuthPolicy;
  const bootstrapCredentials = yield* BootstrapCredentialService;
  const sessions = yield* SessionCredentialService;
  const descriptor = yield* policy.getDescriptor();

  const authenticateToken = (token: string): Effect.Effect<AuthenticatedSession, AuthError> =>
    sessions.verify(token).pipe(
      Effect.map((session) => ({
        subject: session.subject,
        method: session.method,
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Unauthorized request.",
            cause,
          }),
      ),
    );

  const authenticateRequest = (request: HttpServerRequest.HttpServerRequest) => {
    const cookieToken = request.cookies[sessions.cookieName];
    const bearerToken = parseBearerToken(request);
    const queryToken = parseQueryToken(request);
    const credential = cookieToken ?? bearerToken ?? queryToken;
    if (!credential) {
      return Effect.fail(
        new AuthError({
          message: "Authentication required.",
        }),
      );
    }
    return authenticateToken(credential);
  };

  const getSessionState: ServerAuthShape["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchTag("AuthError", () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
    );

  const exchangeBootstrapCredential: ServerAuthShape["exchangeBootstrapCredential"] = (
    credential,
  ) =>
    bootstrapCredentials.consume(credential).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap credential.",
            cause,
          }),
      ),
      Effect.flatMap((grant) =>
        sessions.issue({
          method: "browser-session-cookie",
          subject: grant.method,
        }),
      ),
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            sessionMethod: session.method,
            sessionToken: session.token,
            expiresAt: DateTime.toUtc(session.expiresAt),
          }) satisfies AuthBootstrapResult,
      ),
    );

  const issueStartupPairingUrl: ServerAuthShape["issueStartupPairingUrl"] = (baseUrl) =>
    bootstrapCredentials.issueOneTimeToken().pipe(
      Effect.map((credential) => {
        const url = new URL(baseUrl);
        url.searchParams.set("token", credential);
        return url.toString();
      }),
    );

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState,
    exchangeBootstrapCredential,
    authenticateHttpRequest: authenticateRequest,
    authenticateWebSocketUpgrade: authenticateRequest,
    issueStartupPairingUrl,
  } satisfies ServerAuthShape;
});

export const ServerAuthLive = Layer.effect(ServerAuth, makeServerAuth).pipe(
  Layer.provideMerge(ServerAuthPolicyLive),
  Layer.provideMerge(BootstrapCredentialServiceLive),
  Layer.provideMerge(SessionCredentialServiceLive),
);
