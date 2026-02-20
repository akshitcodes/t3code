import { describe, expect, it, vi } from "vitest";
import type { NativeApi, StateEvent } from "@t3tools/contracts";
import { createStateSource, resolveStateSourceMode } from "./stateSource";

function makeApi(): NativeApi {
  const onStateEvent = vi.fn<(callback: (event: StateEvent) => void) => () => void>((callback) => {
    callback({
      seq: 1,
      eventType: "project.upsert",
      entityId: "project-1",
      payload: {},
      createdAt: "2026-02-20T00:00:00.000Z",
    });
    return () => undefined;
  });

  return {
    todos: {
      list: async () => [],
      add: async () => [],
      toggle: async () => [],
      remove: async () => [],
    },
    dialogs: {
      pickFolder: async () => null,
      confirm: async () => true,
    },
    terminal: {
      open: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restart: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
    },
    agent: {
      spawn: vi.fn(async () => ""),
      kill: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      onOutput: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    },
    providers: {
      startSession: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      sendTurn: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      interruptTurn: vi.fn(async () => undefined),
      respondToRequest: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => []),
      listCheckpoints: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      getCheckpointDiff: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      revertToCheckpoint: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      onEvent: vi.fn(() => () => undefined),
    },
    state: {
      bootstrap: vi.fn(async () => ({
        projects: [],
        threads: [],
        lastStateSeq: 3,
      })),
      listMessages: vi.fn(async () => ({
        messages: [],
        total: 0,
        nextOffset: null,
      })),
      catchUp: vi.fn(async () => ({
        events: [],
        lastStateSeq: 3,
      })),
      onEvent: onStateEvent,
    },
    appSettings: {
      get: vi.fn(async () => ({ codexBinaryPath: "", codexHomePath: "" })),
      update: vi.fn(async () => ({ codexBinaryPath: "", codexHomePath: "" })),
    },
    threads: {
      create: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      delete: vi.fn(async () => undefined),
      markVisited: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      updateTerminalState: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      updateModel: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      updateTitle: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      updateBranch: vi.fn(async () => {
        throw new Error("not implemented");
      }),
    },
    projects: {
      list: vi.fn(async () => []),
      add: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      remove: vi.fn(async () => undefined),
      searchEntries: vi.fn(async () => ({ entries: [], truncated: false })),
      updateScripts: vi.fn(async () => {
        throw new Error("not implemented");
      }),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
    },
    git: {
      pull: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      status: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      runStackedAction: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      listBranches: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      createWorktree: vi.fn(async () => {
        throw new Error("not implemented");
      }),
      removeWorktree: vi.fn(async () => undefined),
      createBranch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
    },
    contextMenu: {
      show: vi.fn(async () => null),
    },
    server: {
      getConfig: vi.fn(async () => ({
        cwd: "/workspace",
        keybindings: [],
      })),
      upsertKeybinding: vi.fn(async () => ({
        keybindings: [],
      })),
    },
  };
}

describe("createStateSource", () => {
  it("delegates bootstrap/catchUp/onEvent to api.state", async () => {
    const api = makeApi();
    const source = createStateSource(api);
    expect(source.mode).toBe("legacy-api");

    await expect(source.bootstrap()).resolves.toEqual({
      projects: [],
      threads: [],
      lastStateSeq: 3,
    });
    await expect(source.catchUp({ afterSeq: 1 })).resolves.toEqual({
      events: [],
      lastStateSeq: 3,
    });

    const received: StateEvent[] = [];
    const unsubscribe = source.onEvent((event) => {
      received.push(event);
    });
    expect(received).toEqual([
      {
        seq: 1,
        eventType: "project.upsert",
        entityId: "project-1",
        payload: {},
        createdAt: "2026-02-20T00:00:00.000Z",
      },
    ]);
    unsubscribe();

    expect(api.state.bootstrap).toHaveBeenCalledTimes(1);
    expect(api.state.catchUp).toHaveBeenCalledWith({ afterSeq: 1 });
    expect(api.state.onEvent).toHaveBeenCalledTimes(1);
  });

  it("supports explicit read-pilot mode selection", async () => {
    const api = makeApi();
    const source = createStateSource(api, { mode: "livestore-read-pilot" });
    expect(source.mode).toBe("livestore-read-pilot");
    await source.bootstrap();
    expect(api.state.bootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("resolveStateSourceMode", () => {
  it("defaults to legacy-api for missing/unknown values", () => {
    expect(resolveStateSourceMode(undefined)).toBe("legacy-api");
    expect(resolveStateSourceMode("unknown")).toBe("legacy-api");
  });

  it("accepts livestore-read-pilot value", () => {
    expect(resolveStateSourceMode("livestore-read-pilot")).toBe("livestore-read-pilot");
  });
});
