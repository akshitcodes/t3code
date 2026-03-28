#!/usr/bin/env bun
/**
 * Minimal NDJSON JSON-RPC "agent" for ACP client tests.
 * Reads stdin lines; writes responses/notifications to stdout.
 */
import * as readline from "node:readline";
import { appendFileSync } from "node:fs";

import { AGENT_METHODS, CLIENT_METHODS } from "effect-acp/schema";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;
const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";
const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";
const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";
const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";
const sessionId = "mock-session-1";
let currentModeId = "ask";
let currentModelId = "default";
let nextRequestId = 1;

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

const availableModes = [
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];
const pendingPermissionRequests = new Map();
const pendingAskQuestionRequests = new Map();
const cancelledPromptRequestIds = new Set<number | string>();

function send(obj: unknown) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function modeState() {
  return {
    currentModeId,
    availableModes,
  };
}

function sendSessionUpdate(update: unknown, session = sessionId) {
  send({
    jsonrpc: "2.0",
    method: CLIENT_METHODS.session_update,
    params: {
      sessionId: session,
      update,
    },
  });
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  if (requestLogPath) {
    appendFileSync(requestLogPath, `${JSON.stringify(msg)}\n`, "utf8");
  }

  const rpcMessage = msg as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  };
  const id = rpcMessage.id;
  const method = rpcMessage.method;

  if (method === undefined && id !== undefined && pendingPermissionRequests.has(id)) {
    const pending = pendingPermissionRequests.get(id);
    pendingPermissionRequests.delete(id);
    const outcome = (rpcMessage.params?.outcome ??
      (msg as { result?: { outcome?: unknown } }).result?.outcome) as
      | { outcome?: unknown }
      | undefined;
    const cancelled =
      cancelledPromptRequestIds.has(pending.promptRequestId) ||
      (typeof outcome === "object" &&
        outcome !== null &&
        "outcome" in outcome &&
        outcome.outcome === "cancelled");
    cancelledPromptRequestIds.delete(pending.promptRequestId);
    sendSessionUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: pending.toolCallId,
        title: "Terminal",
        kind: "execute",
        status: "completed",
        rawOutput: {
          exitCode: 0,
          stdout: '{ "name": "t3" }',
          stderr: "",
        },
      },
      pending.sessionId,
    );
    sendSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from mock" },
      },
      pending.sessionId,
    );
    send({
      jsonrpc: "2.0",
      id: pending.promptRequestId,
      result: { stopReason: cancelled ? "cancelled" : "end_turn" },
    });
    return;
  }

  if (method === undefined && id !== undefined && pendingAskQuestionRequests.has(id)) {
    const pending = pendingAskQuestionRequests.get(id);
    pendingAskQuestionRequests.delete(id);
    send({
      jsonrpc: "2.0",
      id: pending.promptRequestId,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  if (method === AGENT_METHODS.initialize && id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }

  if (method === AGENT_METHODS.authenticate && id !== undefined) {
    send({ jsonrpc: "2.0", id, result: { authenticated: true } });
    return;
  }

  if (method === AGENT_METHODS.session_new && id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        sessionId,
        modes: modeState(),
        configOptions: configOptions(),
      },
    });
    return;
  }

  if (method === AGENT_METHODS.session_load && id !== undefined) {
    const requestedSessionId = rpcMessage.params?.sessionId ?? sessionId;
    sendSessionUpdate(
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "replay" },
      },
      String(requestedSessionId),
    );
    send({
      jsonrpc: "2.0",
      id,
      result: {
        modes: modeState(),
        configOptions: configOptions(),
      },
    });
    return;
  }

  if (method === AGENT_METHODS.session_set_config_option && id !== undefined) {
    if (exitOnSetConfigOption) {
      process.exit(7);
    }
    if (failSetConfigOption) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Mock invalid params for session/set_config_option",
          data: {
            method,
            params: rpcMessage.params,
          },
        },
      });
      return;
    }
    const configId = rpcMessage.params?.configId;
    const value = rpcMessage.params?.value;
    if (configId === "model" && typeof value === "string") {
      currentModelId = value;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: { configOptions: configOptions() },
    });
    return;
  }

  if (method === AGENT_METHODS.session_prompt && id !== undefined) {
    const requestedSessionId = String(rpcMessage.params?.sessionId ?? sessionId);
    if (emitToolCalls) {
      const toolCallId = "tool-call-1";
      const permissionRequestId = nextRequestId++;
      sendSessionUpdate(
        {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Terminal",
          kind: "execute",
          status: "pending",
          rawInput: {
            command: ["cat", "server/package.json"],
          },
        },
        requestedSessionId,
      );
      sendSessionUpdate(
        {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
        },
        requestedSessionId,
      );
      pendingPermissionRequests.set(permissionRequestId, {
        promptRequestId: id,
        sessionId: requestedSessionId,
        toolCallId,
      });
      send({
        jsonrpc: "2.0",
        id: permissionRequestId,
        method: CLIENT_METHODS.session_request_permission,
        params: {
          sessionId: requestedSessionId,
          toolCall: {
            toolCallId,
            title: "`cat server/package.json`",
            kind: "execute",
            status: "pending",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Not in allowlist: cat server/package.json",
                },
              },
            ],
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    if (emitAskQuestion) {
      const askQuestionRequestId = nextRequestId++;
      pendingAskQuestionRequests.set(askQuestionRequestId, {
        promptRequestId: id,
        sessionId: requestedSessionId,
      });
      send({
        jsonrpc: "2.0",
        id: askQuestionRequestId,
        method: "cursor/ask_question",
        params: {
          toolCallId: "ask-question-tool-call-1",
          title: "Question",
          questions: [
            {
              id: "scope",
              prompt: "Which scope?",
              options: [
                { id: "workspace", label: "Workspace" },
                { id: "session", label: "Session" },
              ],
            },
          ],
        },
      });
      return;
    }
    sendSessionUpdate(
      {
        sessionUpdate: "plan",
        explanation: `Mock plan while in ${currentModeId}`,
        entries: [
          {
            content: "Inspect mock ACP state",
            priority: "high",
            status: "completed",
          },
          {
            content: "Implement the requested change",
            priority: "high",
            status: "in_progress",
          },
        ],
      },
      requestedSessionId,
    );
    sendSessionUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from mock" },
      },
      requestedSessionId,
    );
    send({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  if (
    (method === AGENT_METHODS.session_set_mode || method === "session/mode/set") &&
    id !== undefined
  ) {
    const nextModeId =
      typeof rpcMessage.params?.modeId === "string"
        ? rpcMessage.params.modeId
        : typeof rpcMessage.params?.mode === "string"
          ? rpcMessage.params.mode
          : undefined;
    if (typeof nextModeId === "string" && nextModeId.trim()) {
      currentModeId = nextModeId.trim();
      sendSessionUpdate({
        sessionUpdate: "current_mode_update",
        currentModeId,
      });
    }
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === AGENT_METHODS.session_cancel) {
    const cancelledSessionId = rpcMessage.params?.sessionId;
    for (const pending of pendingPermissionRequests.values()) {
      if (pending.sessionId === cancelledSessionId) {
        cancelledPromptRequestIds.add(pending.promptRequestId);
      }
    }
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, result: null });
    }
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unhandled method: ${String(method)}` },
    });
  }
});
