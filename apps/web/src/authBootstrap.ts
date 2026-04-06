import type { AuthBootstrapInput, AuthBootstrapResult, AuthSessionState } from "@t3tools/contracts";

import { resolvePrimaryEnvironmentBootstrapUrl } from "./environmentBootstrap";

export type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;

export function peekPairingTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  return token && token.length > 0 ? token : null;
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token")) {
    return;
  }
  url.searchParams.delete("token");
  window.history.replaceState({}, document.title, url.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

function getBootstrapCredential(): string | null {
  return getDesktopBootstrapCredential();
}

function getDesktopBootstrapCredential(): string | null {
  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}

async function fetchSessionState(baseUrl: string): Promise<AuthSessionState> {
  const response = await fetch(new URL("/api/auth/session", baseUrl), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to load auth session state (${response.status}).`);
  }
  return (await response.json()) as AuthSessionState;
}

async function exchangeBootstrapCredential(
  baseUrl: string,
  credential: string,
): Promise<AuthBootstrapResult> {
  const payload: AuthBootstrapInput = { credential };
  const response = await fetch(new URL("/api/auth/bootstrap", baseUrl), {
    body: JSON.stringify(payload),
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Failed to bootstrap auth session (${response.status}).`);
  }

  return (await response.json()) as AuthBootstrapResult;
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const baseUrl = resolvePrimaryEnvironmentBootstrapUrl();
  const bootstrapCredential = getBootstrapCredential();
  const currentSession = await fetchSessionState(baseUrl);
  if (currentSession.authenticated) {
    return { status: "authenticated" };
  }

  if (!bootstrapCredential) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
    };
  }

  try {
    await exchangeBootstrapCredential(baseUrl, bootstrapCredential);
    return { status: "authenticated" };
  } catch (error) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new Error("Enter a pairing token to continue.");
  }

  await exchangeBootstrapCredential(resolvePrimaryEnvironmentBootstrapUrl(), trimmedCredential);
  stripPairingTokenFromUrl();
}

export function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = bootstrapServerAuth().catch((error) => {
    bootstrapPromise = null;
    throw error;
  });

  return bootstrapPromise;
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
}
