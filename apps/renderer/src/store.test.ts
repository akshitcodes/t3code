import type { ProviderEvent, ProviderSession } from "@acme/contracts";
import { describe, expect, it } from "vitest";

import { type AppState, reducer } from "./store";
import type { Thread } from "./types";

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    sessionId: "sess-1",
    provider: "codex",
    status: "ready",
    createdAt: "2026-02-09T00:00:00.000Z",
    updatedAt: "2026-02-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    id: "evt-1",
    kind: "notification",
    provider: "codex",
    sessionId: "sess-1",
    createdAt: "2026-02-09T00:00:01.000Z",
    method: "thread/started",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-local-1",
    codexThreadId: null,
    projectId: "project-1",
    title: "Thread",
    model: "gpt-5.3-codex",
    session: makeSession(),
    messages: [],
    events: [],
    error: null,
    createdAt: "2026-02-09T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: "project-1",
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        expanded: true,
      },
    ],
    threads: [thread],
    activeThreadId: thread.id,
    runtimeMode: "full-access",
    diffOpen: false,
    runtimeError: null,
  };
}

describe("store reducer thread continuity", () => {
  it("bootstraps project and active thread from runtime response", () => {
    const state: AppState = {
      projects: [],
      threads: [],
      activeThreadId: null,
      runtimeMode: "full-access",
      diffOpen: false,
      runtimeError: null,
    };
    const session = makeSession({
      sessionId: "sess-bootstrap",
      threadId: "thr-bootstrap",
    });

    const next = reducer(state, {
      type: "BOOTSTRAP_FROM_SERVER",
      bootstrap: {
        launchCwd: "/workspace",
        projectName: "workspace",
        provider: "codex",
        model: "gpt-5.3-codex",
        session,
      },
    });

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.cwd).toBe("/workspace");
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.session?.sessionId).toBe("sess-bootstrap");
    expect(next.activeThreadId).toBe(next.threads[0]?.id ?? null);
  });

  it("surfaces bootstrap errors on the active thread", () => {
    const state: AppState = {
      projects: [],
      threads: [],
      activeThreadId: null,
      runtimeMode: "full-access",
      diffOpen: false,
      runtimeError: null,
    };

    const next = reducer(state, {
      type: "BOOTSTRAP_FROM_SERVER",
      bootstrap: {
        launchCwd: "/workspace",
        projectName: "workspace",
        provider: "codex",
        model: "gpt-5.3-codex",
        session: makeSession({
          sessionId: "sess-bootstrap-error",
          status: "error",
        }),
        bootstrapError: "Timed out waiting for initialize.",
      },
    });

    expect(next.threads[0]?.error).toBe("Timed out waiting for initialize.");
  });

  it("stores runtime connection errors separately from thread errors", () => {
    const state = makeState(makeThread());
    const next = reducer(state, {
      type: "SET_RUNTIME_ERROR",
      error: "Connection refused",
    });

    expect(next.runtimeError).toBe("Connection refused");
    expect(next.threads[0]?.error).toBeNull();
  });

  it("stores codexThreadId from UPDATE_SESSION", () => {
    const state = makeState(
      makeThread({
        session: null,
      }),
    );
    const next = reducer(state, {
      type: "UPDATE_SESSION",
      threadId: "thread-local-1",
      session: makeSession({ threadId: "thr_123" }),
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_123");
  });

  it("backfills codexThreadId from routed provider events", () => {
    const state = makeState(makeThread({ codexThreadId: null }));
    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "thread/started",
        payload: { thread: { id: "thr_backfilled" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_backfilled");
  });

  it("surfaces thread id mismatches without overwriting stored identity", () => {
    const state = makeState(makeThread({ codexThreadId: "thr_expected" }));
    const next = reducer(state, {
      type: "APPLY_EVENT",
      event: makeEvent({
        method: "turn/started",
        threadId: "thr_unexpected",
        payload: { turn: { id: "turn-1" } },
      }),
      activeAssistantItemRef: { current: null },
    });

    expect(next.threads[0]?.codexThreadId).toBe("thr_expected");
    expect(next.threads[0]?.error).toContain("Thread identity mismatch");
  });
});
