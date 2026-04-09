import assert from "node:assert/strict";

import {
  type CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type MessageOptions,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { describe, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { makeCopilotAdapterLive } from "./CopilotAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

class FakeCopilotSession {
  public readonly sessionId = "copilot-session-1";
  public readonly send = vi.fn(async (_options: MessageOptions) => undefined);
  public readonly sendAndWait = vi.fn(
    async (_options: MessageOptions, _timeoutMs: number) => undefined,
  );
  public readonly setModel = vi.fn(
    async (_model: string, _options?: { reasoningEffort?: string }) => undefined,
  );
  public readonly abort = vi.fn(async () => undefined);
  public readonly disconnect = vi.fn(async () => undefined);
  public readonly modeSet = vi.fn(async (_input: { mode: "interactive" | "plan" }) => undefined);
  public readonly rpc = {
    mode: {
      set: this.modeSet,
    },
  };

  private listener: ((event: SessionEvent) => void) | undefined;

  public readonly on = vi.fn((listener: (event: SessionEvent) => void) => {
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = undefined;
      }
    };
  });

  emit(event: SessionEvent): void {
    this.listener?.(event);
  }
}

class FakeCopilotClient {
  public createSessionConfig: SessionConfig | undefined;
  public resumeSessionConfig:
    | {
        readonly sessionId: string;
        readonly config: SessionConfig;
      }
    | undefined;
  public readonly stop = vi.fn(async () => []);

  constructor(readonly session: FakeCopilotSession) {}

  readonly createSession = vi.fn(async (config: SessionConfig) => {
    this.createSessionConfig = config;
    return this.session as unknown as CopilotSession;
  });

  readonly resumeSession = vi.fn(async (sessionId: string, config: SessionConfig) => {
    this.resumeSessionConfig = { sessionId, config };
    return this.session as unknown as CopilotSession;
  });
}

function makeHarness() {
  const session = new FakeCopilotSession();
  const client = new FakeCopilotClient(session);
  const layer = makeCopilotAdapterLive({
    createClient: (_options?: CopilotClientOptions) => client as unknown as CopilotClient,
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    client,
    runtime: ManagedRuntime.make(layer),
    session,
  };
}

function makeSessionErrorEvent(message: string): SessionEvent {
  return {
    id: "evt-session-error",
    type: "session.error",
    timestamp: new Date().toISOString(),
    data: {
      message,
    },
  } as SessionEvent;
}

describe("CopilotAdapter", () => {
  it("sends the first turn immediately and sets the model lazily", async () => {
    const harness = makeHarness();

    try {
      const adapter = await harness.runtime.runPromise(Effect.service(CopilotAdapter));
      const threadId = asThreadId("thread-1");

      const session = await harness.runtime.runPromise(
        adapter.startSession({
          provider: "copilot",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "copilot",
            model: "gpt-5.4-mini",
          },
        }),
      );

      assert.equal(session.status, "connecting");
      assert.equal(harness.client.createSessionConfig?.model, undefined);
      assert.equal(harness.client.createSessionConfig?.reasoningEffort, undefined);

      const sendPromise = harness.runtime.runPromise(
        adapter.sendTurn({
          threadId,
          input: "hello",
          modelSelection: {
            provider: "copilot",
            model: "gpt-5.4-mini",
          },
        }),
      );

      await Promise.resolve();
      await sendPromise;

      assert.deepEqual(harness.session.setModel.mock.calls[0]?.[0], "gpt-5.4-mini");
      assert.deepEqual(harness.session.send.mock.calls[0]?.[0], { prompt: "hello" });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it("fails the first turn cleanly when startup emits the model-unavailable error", async () => {
    const harness = makeHarness();

    try {
      const adapter = await harness.runtime.runPromise(Effect.service(CopilotAdapter));
      const threadId = asThreadId("thread-1");
      const modelUnavailable = 'Error: Model "gpt-5.4-mini" is not available.';

      await harness.runtime.runPromise(
        adapter.startSession({
          provider: "copilot",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "copilot",
            model: "gpt-5.4-mini",
          },
        }),
      );

      harness.session.emit(makeSessionErrorEvent(modelUnavailable));

      const exit = await harness.runtime.runPromiseExit(
        adapter.sendTurn({
          threadId,
          input: "hello",
          modelSelection: {
            provider: "copilot",
            model: "gpt-5.4-mini",
          },
        }),
      );
      assert.equal(exit._tag, "Failure");
      const error = Cause.squash(exit.cause);
      assert.ok(Schema.is(ProviderAdapterRequestError)(error));
      assert.match(error.detail, /gpt-5\.4-mini/);
      assert.equal(harness.session.setModel.mock.calls.length, 0);
      assert.equal(harness.session.send.mock.calls.length, 0);
    } finally {
      await harness.runtime.dispose();
    }
  });
});
