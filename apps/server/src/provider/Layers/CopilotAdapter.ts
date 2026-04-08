import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type MessageOptions,
  approveAll,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ChatAttachment,
  EventId,
  type ModelSelection,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, Random, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { resolveCopilotCliPath } from "../copilotCliPath";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";

const PROVIDER = "copilot" as const;

interface CopilotReplayTurn {
  readonly input?: string;
  readonly attachments?: Array<ChatAttachment>;
  readonly interactionMode?: "default" | "plan";
  readonly modelSelection?: ModelSelection;
}

interface CopilotResumeCursor {
  readonly sessionId?: string;
  readonly turns?: ReadonlyArray<CopilotReplayTurn>;
}

interface CopilotTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly replay: CopilotReplayTurn;
  providerTurnId?: string;
  completed: boolean;
  readonly items: Array<unknown>;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly toolCallId?: string;
  readonly decision: Promise<"accept" | "acceptForSession" | "decline" | "cancel">;
  resolve: (decision: "accept" | "acceptForSession" | "decline" | "cancel") => void;
}

interface ApprovalPromise {
  readonly decision: Promise<"accept" | "acceptForSession" | "decline" | "cancel">;
  readonly resolve: (decision: "accept" | "acceptForSession" | "decline" | "cancel") => void;
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly client: CopilotClient;
  readonly copilotSession: CopilotSession;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{
    readonly id: TurnId;
    readonly items: Array<unknown>;
    readonly replay: CopilotReplayTurn;
  }>;
  turnState: CopilotTurnState | undefined;
  currentMode: "interactive" | "plan";
  currentModel: string | undefined;
  stopped: boolean;
  unsubscribe: (() => void) | undefined;
}

export interface CopilotAdapterLiveOptions {
  readonly createClient?: (options?: CopilotClientOptions) => CopilotClient;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(value?: string): EventId {
  return EventId.makeUnsafe(value ?? crypto.randomUUID());
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function readResumeCursor(value: unknown): CopilotResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
  const turns = Array.isArray(record.turns)
    ? (record.turns
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return undefined;
          }
          const turnRecord = entry as Record<string, unknown>;
          const input = typeof turnRecord.input === "string" ? turnRecord.input : undefined;
          const attachments = Array.isArray(turnRecord.attachments)
            ? (turnRecord.attachments as Array<ChatAttachment>)
            : undefined;
          const interactionMode =
            turnRecord.interactionMode === "plan" || turnRecord.interactionMode === "default"
              ? turnRecord.interactionMode
              : undefined;
          const modelSelection =
            turnRecord.modelSelection && typeof turnRecord.modelSelection === "object"
              ? (turnRecord.modelSelection as ModelSelection)
              : undefined;
          return {
            ...(input !== undefined ? { input } : {}),
            ...(attachments !== undefined ? { attachments } : {}),
            ...(interactionMode !== undefined ? { interactionMode } : {}),
            ...(modelSelection !== undefined ? { modelSelection } : {}),
          } satisfies CopilotReplayTurn;
        })
        .filter((turn) => turn !== undefined) as Array<CopilotReplayTurn>)
    : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(turns ? { turns } : {}),
  };
}

function toProviderItemId(value: string): ProviderItemId {
  return ProviderItemId.makeUnsafe(value);
}

function toRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function toRuntimeRequestId(value: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toRuntimeTaskId(value: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(value);
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("terminal") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("agent") || normalized.includes("subagent"))
    return "collab_agent_tool_call";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function classifyPermissionRequest(request: PermissionRequest): CanonicalRequestType {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval";
    case "write":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

function summarizePermissionRequest(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return typeof request.fullCommandText === "string" ? request.fullCommandText : undefined;
    case "write":
      return typeof request.intention === "string"
        ? request.intention
        : typeof request.fileName === "string"
          ? request.fileName
          : undefined;
    case "read":
      return typeof request.path === "string"
        ? request.path
        : typeof request.intention === "string"
          ? request.intention
          : undefined;
    case "url":
      return typeof request.url === "string" ? request.url : undefined;
    case "mcp":
      return typeof request.toolTitle === "string" ? request.toolTitle : undefined;
    case "custom-tool":
      return typeof request.toolDescription === "string" ? request.toolDescription : undefined;
    default:
      return undefined;
  }
}

function toolTitle(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    default:
      return "Tool call";
  }
}

function toolOutputStreamKind(itemType: CanonicalItemType) {
  switch (itemType) {
    case "command_execution":
      return "command_output" as const;
    case "file_change":
      return "file_change_output" as const;
    default:
      return "unknown" as const;
  }
}

function permissionDecisionToResult(
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
): PermissionRequestResult {
  return decision === "accept" || decision === "acceptForSession"
    ? { kind: "approved" }
    : { kind: "denied-interactively-by-user" };
}

function isCopilotModelSelection(
  modelSelection: ModelSelection | undefined,
): modelSelection is Extract<ModelSelection, { provider: "copilot" }> {
  return modelSelection?.provider === "copilot";
}

function buildClientOptions(cwd?: string): CopilotClientOptions {
  const sanitizedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "COPILOT_CLI_PATH" && typeof value === "string",
    ),
  );
  const cliPath = resolveCopilotCliPath();

  return {
    logLevel: "error",
    useStdio: true,
    autoStart: true,
    env: sanitizedEnv,
    ...(cliPath ? { cliPath } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function toPendingApproval(
  request: PermissionRequest,
  approval: ApprovalPromise,
): PendingApproval {
  const detail = summarizePermissionRequest(request);
  return {
    requestType: classifyPermissionRequest(request),
    ...(detail ? { detail } : {}),
    ...(typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {}),
    decision: approval.decision,
    resolve: approval.resolve,
  };
}

const makeCopilotAdapter = Effect.fn("makeCopilotAdapter")(function* (
  options?: CopilotAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CopilotSessionContext>();
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const writeNativeEvent = (event: unknown, threadId: ThreadId) =>
    nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void;

  const requireSession = (threadId: ThreadId) =>
    Effect.sync(() => sessions.get(threadId)).pipe(
      Effect.flatMap((session) =>
        session
          ? Effect.succeed(session)
          : Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              }),
            ),
      ),
    );

  const createApprovalPromise = (): ApprovalPromise => {
    let resolveDecision: ((decision: "accept" | "acceptForSession" | "decline" | "cancel") => void) | undefined;
    const decision = new Promise<"accept" | "acceptForSession" | "decline" | "cancel">((resolve) => {
      resolveDecision = resolve;
    });
    return {
      decision,
      resolve: (value: "accept" | "acceptForSession" | "decline" | "cancel") =>
        resolveDecision?.(value),
    };
  };

  const updateSessionState = (context: CopilotSessionContext, patch: Partial<ProviderSession>) => {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: nowIso(),
      resumeCursor: {
        sessionId: context.copilotSession.sessionId,
        turns: context.turns.map((turn) => turn.replay),
      },
    };
  };

  const buildMessageOptions = Effect.fn("buildMessageOptions")(function* (
    input: CopilotReplayTurn,
  ) {
    const attachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type !== "image") {
            return undefined;
          }
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: toMessage(cause, "Failed to read attachment file."),
                  cause,
                }),
            ),
          );
          return {
            type: "blob" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
            displayName: attachment.name,
          };
        }),
      { concurrency: 1 },
    );

    return {
      prompt: input.input ?? "",
      ...(attachments.filter((entry) => entry !== undefined).length > 0
        ? { attachments: attachments.filter((entry) => entry !== undefined) }
        : {}),
    } satisfies MessageOptions;
  });

  const completeTurn = (context: CopilotSessionContext, state: "completed" | "interrupted" | "failed") =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState || turnState.completed) {
        return;
      }
      turnState.completed = true;
      context.turns.push({
        id: turnState.turnId,
        items: [...turnState.items],
        replay: turnState.replay,
      });
      updateSessionState(context, {
        status: "ready",
        activeTurnId: undefined,
        ...(context.currentModel ? { model: context.currentModel } : {}),
      });
      context.turnState = undefined;

      yield* offerRuntimeEvent({
        eventId: makeEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: nowIso(),
        turnId: turnState.turnId,
        type: "task.completed",
        payload: {
          taskId: toRuntimeTaskId(turnState.turnId),
          status: state === "failed" ? "failed" : state === "interrupted" ? "stopped" : "completed",
        },
      });
      yield* offerRuntimeEvent({
        eventId: makeEventId(),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: nowIso(),
        turnId: turnState.turnId,
        ...(turnState.providerTurnId
          ? { providerRefs: { providerTurnId: turnState.providerTurnId } }
          : {}),
        type: "turn.completed",
        payload: {
          state,
        },
      });
    });

  const handleSessionEvent = (context: CopilotSessionContext, event: SessionEvent) =>
    Effect.gen(function* () {
      const base = {
        eventId: makeEventId(event.id),
        provider: PROVIDER,
        threadId: context.session.threadId,
        createdAt: event.timestamp,
      };

      switch (event.type) {
        case "session.warning":
        case "session.info":
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.warning",
            payload: {
              message: event.data.message,
              detail: event,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "session.error":
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.error",
            payload: {
              message: event.data.message,
              class: "provider_error",
              detail: event,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          if (context.turnState) {
            yield* completeTurn(context, "failed");
          }
          return;
        case "session.idle":
          if (context.turnState) {
            yield* completeTurn(context, event.data.aborted ? "interrupted" : "completed");
          }
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "ready" },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "session.title_changed":
          yield* offerRuntimeEvent({
            ...base,
            type: "thread.metadata.updated",
            payload: { name: event.data.title },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "assistant.turn_start":
          if (context.turnState) {
            context.turnState.providerTurnId = event.data.turnId;
          }
          return;
        case "assistant.intent":
          if (!context.turnState) return;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            type: "task.progress",
            payload: {
              taskId: toRuntimeTaskId(context.turnState.turnId),
              description: event.data.intent,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "assistant.reasoning_delta":
          if (!context.turnState) return;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId: toRuntimeItemId(event.data.reasoningId),
            providerRefs: { providerItemId: toProviderItemId(event.data.reasoningId) },
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: event.data.deltaContent,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "assistant.reasoning":
          if (!context.turnState) return;
          context.turnState.items.push(event);
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId: toRuntimeItemId(event.data.reasoningId),
            providerRefs: { providerItemId: toProviderItemId(event.data.reasoningId) },
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Reasoning",
              detail: event.data.content,
              data: event,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "assistant.message_delta":
          if (!context.turnState) return;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId: toRuntimeItemId(event.data.messageId),
            providerRefs: { providerItemId: toProviderItemId(event.data.messageId) },
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.data.deltaContent,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "assistant.message":
          if (!context.turnState) return;
          context.turnState.items.push(event);
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId: toRuntimeItemId(event.data.messageId),
            providerRefs: { providerItemId: toProviderItemId(event.data.messageId) },
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: event.data.content,
              data: event,
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
        case "assistant.usage":
          if (!context.turnState) return;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: (event.data.inputTokens ?? 0) + (event.data.outputTokens ?? 0),
                ...(event.data.inputTokens !== undefined
                  ? { inputTokens: event.data.inputTokens, lastInputTokens: event.data.inputTokens }
                  : {}),
                ...(event.data.cacheReadTokens !== undefined
                  ? {
                      cachedInputTokens: event.data.cacheReadTokens,
                      lastCachedInputTokens: event.data.cacheReadTokens,
                    }
                  : {}),
                ...(event.data.outputTokens !== undefined
                  ? {
                      outputTokens: event.data.outputTokens,
                      lastOutputTokens: event.data.outputTokens,
                    }
                  : {}),
                lastUsedTokens: (event.data.inputTokens ?? 0) + (event.data.outputTokens ?? 0),
                ...(event.data.duration !== undefined ? { durationMs: event.data.duration } : {}),
              },
            },
            raw: { source: "copilot.sdk.event", method: event.type, payload: event },
          });
          return;
      }

      if (event.type === "tool.execution_start" && context.turnState) {
        const itemType = classifyToolItemType(event.data.toolName);
        context.turnState.items.push(event);
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          itemId: toRuntimeItemId(event.data.toolCallId),
          providerRefs: { providerItemId: toProviderItemId(event.data.toolCallId) },
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title: toolTitle(itemType),
            detail: event.data.toolName,
            data: event,
          },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "tool.execution_partial_result" && context.turnState) {
        const started = context.turnState.items.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            (item as { type?: string }).type === "tool.execution_start" &&
            (item as { data?: { toolCallId?: string } }).data?.toolCallId === event.data.toolCallId,
        ) as { data?: { toolName?: string } } | undefined;
        const itemType = classifyToolItemType(started?.data?.toolName ?? "tool");
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          itemId: toRuntimeItemId(event.data.toolCallId),
          providerRefs: { providerItemId: toProviderItemId(event.data.toolCallId) },
          type: "content.delta",
          payload: {
            streamKind: toolOutputStreamKind(itemType),
            delta: event.data.partialOutput,
          },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "tool.execution_progress" && context.turnState) {
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          itemId: toRuntimeItemId(event.data.toolCallId),
          providerRefs: { providerItemId: toProviderItemId(event.data.toolCallId) },
          type: "tool.progress",
          payload: {
            toolUseId: event.data.toolCallId,
            summary: event.data.progressMessage,
          },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "tool.execution_complete" && context.turnState) {
        const started = context.turnState.items.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            (item as { type?: string }).type === "tool.execution_start" &&
            (item as { data?: { toolCallId?: string } }).data?.toolCallId === event.data.toolCallId,
        ) as { data?: { toolName?: string } } | undefined;
        const itemType = classifyToolItemType(started?.data?.toolName ?? "tool");
        const detail =
          event.data.result?.detailedContent ??
          event.data.result?.content ??
          event.data.error?.message ??
          started?.data?.toolName;
        context.turnState.items.push(event);
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          itemId: toRuntimeItemId(event.data.toolCallId),
          providerRefs: { providerItemId: toProviderItemId(event.data.toolCallId) },
          type: "item.completed",
          payload: {
            itemType,
            status: event.data.success ? "completed" : "failed",
            title: toolTitle(itemType),
            ...(detail ? { detail } : {}),
            data: event,
          },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "session.mcp_server_status_changed") {
        yield* offerRuntimeEvent({
          ...base,
          type: "mcp.status.updated",
          payload: { status: event.data },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "mcp.oauth_completed") {
        yield* offerRuntimeEvent({
          ...base,
          type: "mcp.oauth.completed",
          payload: { success: true },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "exit_plan_mode.requested" && context.turnState) {
        yield* offerRuntimeEvent({
          ...base,
          turnId: context.turnState.turnId,
          type: "turn.proposed.completed",
          payload: { planMarkdown: event.data.planContent },
          raw: { source: "copilot.sdk.event", method: event.type, payload: event },
        });
        return;
      }

      if (event.type === "abort" && context.turnState) {
        yield* completeTurn(context, "interrupted");
      }
    });

  const attachListener = (context: CopilotSessionContext) => {
    context.unsubscribe = context.copilotSession.on((event) => {
      void runPromise(
        writeNativeEvent(event, context.session.threadId).pipe(
          Effect.flatMap(() => handleSessionEvent(context, event)),
        ),
      );
    });
  };

  const createRuntimeContext = Effect.fn("createRuntimeContext")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd?: string;
    readonly runtimeMode: ProviderSession["runtimeMode"];
    readonly modelSelection?: Extract<ModelSelection, { provider: "copilot" }>;
    readonly resumeCursor?: CopilotResumeCursor;
    readonly attachListener?: boolean;
  }) {
    const createClient =
      options?.createClient ??
      ((clientOptions?: CopilotClientOptions) => new CopilotClient(clientOptions));
    const client = createClient(buildClientOptions(input.cwd));
    const contextRef: { current?: CopilotSessionContext } = {};
    const sessionConfig: SessionConfig = {
      onPermissionRequest:
        input.runtimeMode === "full-access"
          ? approveAll
          : async (request) => {
              const context = contextRef.current;
              if (!context) {
                return { kind: "denied-interactively-by-user" };
              }
              const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
              const approval = createApprovalPromise();
              const pending = toPendingApproval(request, approval);
              context.pendingApprovals.set(requestId, pending);

              await runPromise(
                offerRuntimeEvent({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  createdAt: nowIso(),
                  ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                  requestId: toRuntimeRequestId(requestId),
                  ...(pending.toolCallId
                    ? {
                        itemId: toRuntimeItemId(pending.toolCallId),
                        providerRefs: {
                          providerItemId: toProviderItemId(pending.toolCallId),
                          providerRequestId: requestId,
                        },
                      }
                    : {
                        providerRefs: {
                          providerRequestId: requestId,
                        },
                      }),
                  type: "request.opened",
                  payload: {
                    requestType: pending.requestType,
                    ...(pending.detail ? { detail: pending.detail } : {}),
                    args: request,
                  },
                  raw: {
                    source: "copilot.sdk.permission",
                    method: "onPermissionRequest",
                    payload: request,
                  },
                }),
              );

              const resolved = await pending.decision;
              context.pendingApprovals.delete(requestId);
              await runPromise(
                offerRuntimeEvent({
                  eventId: makeEventId(),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  createdAt: nowIso(),
                  ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                  requestId: toRuntimeRequestId(requestId),
                  ...(pending.toolCallId
                    ? {
                        itemId: toRuntimeItemId(pending.toolCallId),
                        providerRefs: {
                          providerItemId: toProviderItemId(pending.toolCallId),
                          providerRequestId: requestId,
                        },
                      }
                    : {
                        providerRefs: {
                          providerRequestId: requestId,
                        },
                      }),
                  type: "request.resolved",
                  payload: {
                    requestType: pending.requestType,
                    decision: resolved,
                  },
                  raw: {
                    source: "copilot.sdk.permission",
                    method: "onPermissionRequest/decision",
                    payload: { decision: resolved },
                  },
                }),
              );

              return permissionDecisionToResult(resolved);
            },
      streaming: true,
      ...(input.cwd ? { workingDirectory: input.cwd } : {}),
      ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
      ...(input.modelSelection?.options?.reasoningEffort
        ? { reasoningEffort: input.modelSelection.options.reasoningEffort }
        : {}),
    };

    const copilotSession = yield* Effect.tryPromise({
      try: () =>
        input.resumeCursor?.sessionId
          ? client.resumeSession(input.resumeCursor.sessionId, sessionConfig)
          : client.createSession(sessionConfig),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to start GitHub Copilot session."),
          cause,
        }),
    });

    const context: CopilotSessionContext = {
      session: {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        resumeCursor: {
          sessionId: copilotSession.sessionId,
          turns: [...(input.resumeCursor?.turns ?? [])],
        },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      client,
      copilotSession,
      pendingApprovals: new Map(),
      turns: (input.resumeCursor?.turns ?? []).map((turn) => ({
        id: TurnId.makeUnsafe(crypto.randomUUID()),
        items: [],
        replay: turn,
      })),
      turnState: undefined,
      currentMode: "interactive",
      currentModel: input.modelSelection?.model,
      stopped: false,
      unsubscribe: undefined,
    };
    contextRef.current = context;
    sessions.set(input.threadId, context);
    if (input.attachListener !== false) {
      attachListener(context);
    }

    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      type: "session.started",
      payload: input.resumeCursor ? { resume: input.resumeCursor } : {},
    });
    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      type: "session.configured",
      payload: {
        config: {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        },
      },
    });
    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      type: "session.state.changed",
      payload: { state: "ready" },
    });
    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      type: "thread.started",
      payload: { providerThreadId: copilotSession.sessionId },
      providerRefs: { providerTurnId: copilotSession.sessionId },
    });

    return context;
  });

  const replayTurnsIntoContext = Effect.fn("replayTurnsIntoContext")(function* (
    context: CopilotSessionContext,
    turns: ReadonlyArray<CopilotReplayTurn>,
  ) {
    context.turns.length = 0;
    for (const replayTurn of turns) {
      if (replayTurn.interactionMode === "plan") {
        yield* Effect.tryPromise({
          try: () => context.copilotSession.rpc.mode.set({ mode: "plan" }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.mode.set",
              detail: toMessage(cause, "Failed to restore Copilot plan mode."),
              cause,
            }),
        });
        context.currentMode = "plan";
      } else {
        yield* Effect.tryPromise({
          try: () => context.copilotSession.rpc.mode.set({ mode: "interactive" }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.mode.set",
              detail: toMessage(cause, "Failed to restore Copilot mode."),
              cause,
            }),
        });
        context.currentMode = "interactive";
      }

      const replayModelSelection = isCopilotModelSelection(replayTurn.modelSelection)
        ? replayTurn.modelSelection
        : undefined;
      if (replayModelSelection) {
        yield* Effect.tryPromise({
          try: () =>
            context.copilotSession.setModel(replayModelSelection.model, {
              ...(replayModelSelection.options?.reasoningEffort
                ? { reasoningEffort: replayModelSelection.options.reasoningEffort }
                : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session.setModel",
              detail: toMessage(cause, "Failed to restore Copilot model."),
              cause,
            }),
        });
        context.currentModel = replayModelSelection.model;
      }

      const messageOptions = yield* buildMessageOptions(replayTurn);
      yield* Effect.tryPromise({
        try: () => context.copilotSession.sendAndWait(messageOptions, 300_000),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.replay",
            detail: toMessage(cause, "Failed to replay Copilot turn."),
            cause,
          }),
      });
      context.turns.push({
        id: TurnId.makeUnsafe(crypto.randomUUID()),
        items: [],
        replay: replayTurn,
      });
    }
    updateSessionState(context, { status: "ready", activeTurnId: undefined });
  });

  const stopContext = (context: CopilotSessionContext, emitExitEvent: boolean) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      context.unsubscribe?.();
      yield* Effect.tryPromise({
        try: () => context.copilotSession.disconnect(),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
      yield* Effect.tryPromise({
        try: () => context.client.stop(),
        catch: () => [],
      }).pipe(Effect.catch(() => Effect.void));
      sessions.delete(context.session.threadId);

      if (emitExitEvent) {
        yield* offerRuntimeEvent({
          eventId: makeEventId(),
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: nowIso(),
          type: "session.exited",
          payload: { exitKind: "graceful" },
        });
      }
    });

  const startSession: CopilotAdapterShape["startSession"] = Effect.fn("startSession")(function* (
    input,
  ) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const resumeCursor = readResumeCursor(input.resumeCursor);
    const modelSelection = isCopilotModelSelection(input.modelSelection)
      ? input.modelSelection
      : undefined;

    const context = yield* createRuntimeContext({
      threadId: input.threadId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      runtimeMode: input.runtimeMode,
      ...(modelSelection ? { modelSelection } : {}),
      ...(resumeCursor ? { resumeCursor } : {}),
    });
    return context.session;
  });

  const sendTurn: CopilotAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.turnState && !context.turnState.completed) {
      yield* completeTurn(context, "completed");
    }

    const modelSelection = isCopilotModelSelection(input.modelSelection)
      ? input.modelSelection
      : undefined;
    if (modelSelection?.model && modelSelection.model !== context.currentModel) {
      yield* Effect.tryPromise({
        try: () =>
          context.copilotSession.setModel(modelSelection.model, {
            ...(modelSelection.options?.reasoningEffort
              ? { reasoningEffort: modelSelection.options.reasoningEffort }
              : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.setModel",
            detail: toMessage(cause, "Failed to switch Copilot model."),
            cause,
          }),
      });
      context.currentModel = modelSelection.model;
    }

    const nextMode = input.interactionMode === "plan" ? "plan" : "interactive";
    if (context.currentMode !== nextMode) {
      yield* Effect.tryPromise({
        try: () => context.copilotSession.rpc.mode.set({ mode: nextMode }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.mode.set",
            detail: toMessage(cause, "Failed to switch Copilot interaction mode."),
            cause,
          }),
      });
      context.currentMode = nextMode;
    }

    const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
    const replay: CopilotReplayTurn = {
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
      ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
      ...(modelSelection ? { modelSelection } : {}),
    };
    context.turnState = {
      turnId,
      startedAt: nowIso(),
      replay,
      completed: false,
      items: [],
    };
    updateSessionState(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.currentModel ? { model: context.currentModel } : {}),
    });

    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      turnId,
      type: "session.state.changed",
      payload: { state: "running" },
    });
    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      turnId,
      type: "turn.started",
      payload: {
        ...(context.currentModel ? { model: context.currentModel } : {}),
      },
    });
    yield* offerRuntimeEvent({
      eventId: makeEventId(),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt: nowIso(),
      turnId,
      type: "task.started",
      payload: { taskId: toRuntimeTaskId(turnId) },
    });

    const messageOptions = yield* buildMessageOptions(replay);
    yield* Effect.tryPromise({
      try: () => context.copilotSession.send(messageOptions),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: toMessage(cause, "Failed to send Copilot turn."),
          cause,
        }),
    });

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: context.session.resumeCursor,
    };
  });

  const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId, _turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) =>
        Effect.tryPromise({
          try: () => context.copilotSession.abort(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: toMessage(cause, "Failed to interrupt Copilot turn."),
              cause,
            }),
        }),
      ),
    );

  const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.map((context) => ({
        threadId,
        turns: [
          ...context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
          ...(context.turnState
            ? [{ id: context.turnState.turnId, items: [...context.turnState.items] }]
            : []),
        ],
      })),
    );

  const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const existing = yield* requireSession(threadId);
      const nextReplayTurns = existing.turns
        .slice(0, Math.max(0, existing.turns.length - numTurns))
        .map((turn) => turn.replay);
      const modelSelection = existing.currentModel
        ? ({
            provider: PROVIDER,
            model: existing.currentModel,
          } as const)
        : undefined;

      yield* stopContext(existing, false);

      const context = yield* createRuntimeContext({
        threadId,
        ...(existing.session.cwd ? { cwd: existing.session.cwd } : {}),
        runtimeMode: existing.session.runtimeMode,
        ...(modelSelection ? { modelSelection } : {}),
        attachListener: false,
      });
      yield* replayTurnsIntoContext(context, nextReplayTurns);
      attachListener(context);

      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    });

  const respondToRequest: CopilotAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((context) => {
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission/respond",
              detail: `Unknown pending approval request: ${requestId}`,
            }),
          );
        }
        context.pendingApprovals.delete(requestId);
        pending.resolve(decision);
        return Effect.void;
      }),
    );

  const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers,
  ) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "respondToUserInput",
        issue: "GitHub Copilot user-input callbacks are not supported in this integration.",
      }),
    );

  const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap((context) => stopContext(context, true)));

  const listSessions: CopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: CopilotAdapterShape["stopAll"] = () =>
    Effect.forEach(sessions, ([, context]) => stopContext(context, true), { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions, ([, context]) => stopContext(context, false), {
      discard: true,
    }).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "restart-session" },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CopilotAdapterShape;
});

export const CopilotAdapterLive = Layer.effect(CopilotAdapter, makeCopilotAdapter());

export function makeCopilotAdapterLive(options?: CopilotAdapterLiveOptions) {
  return Layer.effect(CopilotAdapter, makeCopilotAdapter(options));
}
