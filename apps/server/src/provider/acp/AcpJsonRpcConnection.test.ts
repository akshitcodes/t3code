import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { makeAcpJsonRpcConnection } from "./AcpJsonRpcConnection.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.mjs");

describe("AcpJsonRpcConnection", () => {
  it.effect("performs initialize → session/new → session/prompt against mock agent", () =>
    Effect.gen(function* () {
      const conn = yield* makeAcpJsonRpcConnection({
        command: process.execPath,
        args: [mockAgentPath],
      });

      const initResult = yield* conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-test", version: "0.0.0" },
      });
      expect(initResult).toMatchObject({ protocolVersion: 1 });

      yield* conn.request("authenticate", { methodId: "cursor_login" });

      const newResult = yield* conn.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });
      expect(newResult).toMatchObject({ sessionId: "mock-session-1" });

      const promptResult = yield* conn.request("session/prompt", {
        sessionId: "mock-session-1",
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = yield* Stream.runCollect(Stream.take(conn.notifications, 1));
      expect(notes.length).toBe(1);
      expect(notes[0]?._tag).toBe("notification");
      if (notes[0]?._tag === "notification") {
        expect(notes[0].method).toBe("session/update");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
