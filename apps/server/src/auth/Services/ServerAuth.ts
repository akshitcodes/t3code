import type {
  AuthBootstrapResult,
  AuthSessionState,
  ServerAuthDescriptor,
  ServerAuthSessionMethod,
} from "@t3tools/contracts";
import { Data, DateTime, ServiceMap } from "effect";
import type { Effect } from "effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export interface AuthenticatedSession {
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt?: DateTime.DateTime;
}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerAuthShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  readonly getSessionState: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthSessionState, never>;
  readonly exchangeBootstrapCredential: (
    credential: string,
  ) => Effect.Effect<AuthBootstrapResult, AuthError>;
  readonly authenticateHttpRequest: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<AuthenticatedSession, AuthError>;
  readonly issueStartupPairingUrl: (baseUrl: string) => Effect.Effect<string, never>;
}

export class ServerAuth extends ServiceMap.Service<ServerAuth, ServerAuthShape>()(
  "t3/auth/Services/ServerAuth",
) {}
