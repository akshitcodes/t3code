import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  static failSend = false;
  static failOpen = false;

  readyState = 0;
  binaryType = "blob";
  sentMessages: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.failOpen) {
        this.emit("error", { message: "mock open failure" });
        return;
      }
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener) {
    const next = this.listeners[type] ?? [];
    next.push(listener);
    this.listeners[type] = next;
  }

  send(data: string) {
    if (MockWebSocket.failSend) {
      throw new Error("mock send failure");
    }

    this.sentMessages.push(String(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }

  emitMessage(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: string, event: unknown) {
    const listeners = this.listeners[type] ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function setWindowSearch(search: string) {
  vi.stubGlobal("window", {
    location: {
      search,
    },
  });
}

function waitForCondition(check: () => boolean, timeoutMs = 1_000) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for test condition."));
      }
    }, 10);
  });
}

describe("wsNativeApi", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    MockWebSocket.failSend = false;
    MockWebSocket.failOpen = false;
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  it("connects using ws query parameter and resolves responses", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4400%3Ftoken%3Dabc");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();

    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    expect(socket?.url).toBe("ws://127.0.0.1:4400?token=abc");
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      type: string;
      id: string;
      method: string;
    };
    expect(requestEnvelope.type).toBe("request");
    expect(requestEnvelope.method).toBe("todos.list");

    socket?.emitMessage(
      JSON.stringify({
        type: "hello",
        version: 1,
        launchCwd: "/workspace",
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("rejects immediately when websocket send throws", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4401");
    MockWebSocket.failSend = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to send runtime request 'todos.list': mock send failure",
    );
  });

  it("sends app.health requests to runtime", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4411");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.app.health();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
      method: string;
    };
    expect(requestEnvelope.method).toBe("app.health");

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: {
          status: "ok",
          launchCwd: "/workspace",
          sessionCount: 0,
          activeClientConnected: true,
        },
      }),
    );

    await expect(request).resolves.toEqual({
      status: "ok",
      launchCwd: "/workspace",
      sessionCount: 0,
      activeClientConnected: true,
    });
  });

  it("falls back to default local runtime URL when ws query is missing", async () => {
    setWindowSearch("");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    expect(socket?.url).toBe("ws://127.0.0.1:4317");

    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("rejects request when runtime responds with structured error", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4402");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: false,
        error: {
          code: "request_failed",
          message: "boom",
        },
      }),
    );

    await expect(request).rejects.toThrow("boom");
  });

  it("rejects pending requests when websocket disconnects", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4403");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    socket?.close();

    await expect(request).rejects.toThrow("websocket disconnected");
  });

  it("returns a stable cached native API instance", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4404");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");

    const first = getOrCreateWsNativeApi();
    const second = getOrCreateWsNativeApi();

    expect(second).toBe(first);
  });

  it("rejects requests when websocket connection fails", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4405");
    MockWebSocket.failOpen = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow("Failed to connect to local t3 runtime.");
  });

  it("accepts arraybuffer server messages", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4406");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    const encoded = new TextEncoder().encode(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    socket?.emitMessage(encoded.buffer);

    await expect(request).resolves.toEqual([]);
  });

  it("accepts blob server messages", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4407");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      new Blob([
        JSON.stringify({
          type: "response",
          id: requestEnvelope.id,
          ok: true,
          result: [],
        }),
      ]),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("ignores invalid server messages and still resolves on valid response", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4408");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage("not json");
    socket?.emitMessage(JSON.stringify({ type: "event", channel: "unknown", payload: null }));
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("dispatches provider events to subscribers and supports unsubscribe", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4409");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const received: unknown[] = [];
    const unsubscribe = api.providers.onEvent((event) => {
      received.push(event);
    });

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(request).resolves.toEqual([]);

    const payload = {
      id: "evt-1",
      kind: "notification",
      provider: "codex",
      sessionId: "sess-1",
      createdAt: "2026-02-01T00:00:00.000Z",
      method: "turn/started",
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "provider:event",
        payload,
      }),
    );
    await waitForCondition(() => received.length === 1);

    unsubscribe();
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "provider:event",
        payload: { ...payload, id: "evt-2" },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(received).toHaveLength(1);
  });

  it("dispatches agent output and exit events to subscribers", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4410");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const outputEvents: unknown[] = [];
    const exitEvents: unknown[] = [];
    const unsubscribeOutput = api.agent.onOutput((event) => {
      outputEvents.push(event);
    });
    const unsubscribeExit = api.agent.onExit((event) => {
      exitEvents.push(event);
    });

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );
    await expect(request).resolves.toEqual([]);

    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:output",
        payload: {
          sessionId: "agent-session-1",
          stream: "stdout",
          data: "hello",
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:exit",
        payload: {
          sessionId: "agent-session-1",
          code: 0,
          signal: null,
        },
      }),
    );

    await waitForCondition(() => outputEvents.length === 1 && exitEvents.length === 1);

    unsubscribeOutput();
    unsubscribeExit();
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:output",
        payload: {
          sessionId: "agent-session-1",
          stream: "stdout",
          data: "ignored",
        },
      }),
    );
    socket?.emitMessage(
      JSON.stringify({
        type: "event",
        channel: "agent:exit",
        payload: {
          sessionId: "agent-session-1",
          code: 1,
          signal: null,
        },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(outputEvents).toHaveLength(1);
    expect(exitEvents).toHaveLength(1);
  });
});
