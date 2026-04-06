import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { HttpResponse, http } from "msw";

const TEST_SESSION_EXPIRES_AT = "2026-05-01T12:00:00.000Z";
const TEST_SESSION_TOKEN = "browser-test-session-token";

export function createAuthenticatedSessionHandlers(getAuthDescriptor: () => ServerAuthDescriptor) {
  return [
    http.get("*/api/auth/session", () =>
      HttpResponse.json({
        authenticated: true,
        auth: getAuthDescriptor(),
        sessionMethod: "browser-session-cookie",
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
    http.post("*/api/auth/bootstrap", () =>
      HttpResponse.json({
        authenticated: true,
        sessionMethod: "browser-session-cookie",
        sessionToken: TEST_SESSION_TOKEN,
        expiresAt: TEST_SESSION_EXPIRES_AT,
      }),
    ),
  ] as const;
}
