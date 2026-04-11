import { homedir } from "node:os";
import nodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Scope,
  ServiceMap,
} from "effect";

import { ServerConfig } from "./config";
import { Keybindings } from "./keybindings";
import { Open } from "./open";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderSessionRuntimeRepository } from "./persistence/Services/ProviderSessionRuntime";
import {
  claudePermissionModeToInteractionMode,
  claudePermissionModeToRuntimeMode,
  claudeSessionToModelSelection,
  discoverClaudeNativeSessions,
  normalizeWorkspaceRootForLookup,
  readClaudeSessionIdFromResumeCursor,
} from "./provider/claudeNativeSessions";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerSettingsService } from "./serverSettings";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export class ServerRuntimeStartupError extends Data.TaggedError("ServerRuntimeStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerRuntimeStartupShape {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

export class ServerRuntimeStartup extends ServiceMap.Service<
  ServerRuntimeStartup,
  ServerRuntimeStartupShape
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

const autoBootstrapWelcome = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = new Date().toISOString();
        nextProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = {
          provider: "codex",
          model: "gpt-5-codex",
        };
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection = existingProject.value.defaultModelSelection ?? {
          provider: "codex",
          model: "gpt-5-codex",
        };
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = new Date().toISOString();
        const createdThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const importClaudeNativeSessions = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  if (!settings.providers.claudeAgent.enabled) {
    return {
      discovered: 0,
      imported: 0,
      skipped: 0,
      projectsCreated: 0,
      reason: "provider-disabled",
    } as const;
  }

  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerSessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;

  const projectsRoot = nodePath.join(homedir(), ".claude", "projects");
  const discovered = yield* Effect.tryPromise({
    try: () => discoverClaudeNativeSessions(projectsRoot),
    catch: (cause) =>
      new ServerRuntimeStartupError({
        message: `Failed to scan Claude native sessions under '${projectsRoot}'.`,
        cause,
      }),
  });

  if (discovered.length === 0) {
    return {
      discovered: 0,
      imported: 0,
      skipped: 0,
      projectsCreated: 0,
      reason: "no-native-sessions",
    } as const;
  }

  const existingRuntimeBindings = yield* providerSessionRuntimeRepository.list().pipe(
    Effect.mapError((cause) =>
      new ServerRuntimeStartupError({
        message: "Failed to read persisted provider runtime bindings.",
        cause,
      }),
    ),
  );
  const existingClaudeSessionIds = new Set(
    existingRuntimeBindings
      .filter((binding) => binding.providerName === "claudeAgent")
      .flatMap((binding) => {
        const sessionId = readClaudeSessionIdFromResumeCursor(binding.resumeCursor);
        return sessionId ? [sessionId] : [];
      }),
  );

  const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
    Effect.mapError((cause) =>
      new ServerRuntimeStartupError({
        message: "Failed to read orchestration snapshot before Claude session import.",
        cause,
      }),
    ),
  );

  const activeProjectsByWorkspaceRoot = new Map(
    snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => [normalizeWorkspaceRootForLookup(project.workspaceRoot), project] as const),
  );

  let imported = 0;
  let skipped = 0;
  let projectsCreated = 0;

  for (const session of discovered) {
    if (existingClaudeSessionIds.has(session.sessionId)) {
      skipped += 1;
      continue;
    }

    const normalizedWorkspaceRoot = normalizeWorkspaceRootForLookup(session.cwd);
    let project = activeProjectsByWorkspaceRoot.get(normalizedWorkspaceRoot);
    const modelSelection = claudeSessionToModelSelection(session.model);

    if (!project) {
      const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
      const createdAt = session.createdAt;
      const title = nodePath.basename(session.cwd) || "Claude project";
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        projectId,
        title,
        workspaceRoot: session.cwd,
        defaultModelSelection: modelSelection,
        createdAt,
      });

      project = {
        id: projectId,
        title,
        workspaceRoot: session.cwd,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
      };
      activeProjectsByWorkspaceRoot.set(normalizedWorkspaceRoot, project);
      projectsCreated += 1;
    }

    const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
    const runtimeMode = claudePermissionModeToRuntimeMode(session.permissionMode);
    const interactionMode = claudePermissionModeToInteractionMode(session.permissionMode);
    const createdAt = session.createdAt;

    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      projectId: project.id,
      title: session.title,
      modelSelection:
        project.defaultModelSelection ??
        modelSelection ??
        ({
          provider: "claudeAgent",
          model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
        } satisfies ModelSelection),
      interactionMode:
        interactionMode === "plan" ? "plan" : DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode,
      branch: session.gitBranch ?? null,
      worktreePath: null,
      createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId,
      createdAt: session.updatedAt,
      session: {
        threadId,
        status: "stopped",
        providerName: "claudeAgent",
        runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: session.updatedAt,
      },
    });

    yield* providerSessionRuntimeRepository.upsert({
      threadId,
      providerName: "claudeAgent",
      adapterKey: "claudeAgent",
      runtimeMode,
      status: "stopped",
      lastSeenAt: session.updatedAt,
      resumeCursor: {
        resume: session.sessionId,
        turnCount: 0,
      },
      runtimePayload: {
        cwd: session.cwd,
        modelSelection,
        nativeSessionId: session.sessionId,
        nativeSessionPath: session.sourcePath,
        nativeEntrypoint: session.entrypoint ?? null,
        nativeSlug: session.slug ?? null,
      },
    });

    existingClaudeSessionIds.add(session.sessionId);
    imported += 1;
  }

  return {
    discovered: discovered.length,
    imported,
    skipped,
    projectsCreated,
  } as const;
});

const maybeOpenBrowser = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  if (serverConfig.noBrowser) {
    return;
  }
  const { openBrowser } = yield* Open;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const target = serverConfig.devUrl?.toString() ?? bindUrl;

  yield* openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        hint: `Open ${target} in your browser.`,
      }),
    ),
  );
});

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

const makeServerRuntimeStartup = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const keybindings = yield* Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const serverSettings = yield* ServerSettingsService;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

  yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* runStartupPhase(
      "keybindings.start",
      keybindings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start keybindings runtime", {
            path: error.configPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* runStartupPhase(
      "settings.start",
      serverSettings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start server settings runtime", {
            path: error.settingsPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
      orchestrationReactor.start().pipe(Scope.provide(reactorScope)),
    );

    yield* Effect.logDebug("startup phase: preparing welcome payload");
    const welcome = yield* runStartupPhase("welcome.prepare", autoBootstrapWelcome);
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      cwd: welcome.cwd,
      projectName: welcome.projectName,
      bootstrapProjectId: welcome.bootstrapProjectId,
      bootstrapThreadId: welcome.bootstrapThreadId,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: welcome,
      }),
    );

    yield* Effect.logDebug("startup phase: importing Claude native sessions");
    const claudeImport = yield* runStartupPhase(
      "claude.import",
      importClaudeNativeSessions.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to import Claude native sessions", {
            detail: error.message,
            cause: error.cause,
          }).pipe(
            Effect.as({
              discovered: 0,
              imported: 0,
              skipped: 0,
              projectsCreated: 0,
              reason: "import-failed",
            } as const),
          ),
        ),
      ),
    );
    yield* Effect.logInfo("startup phase: Claude native session import complete", claudeImport);
  }).pipe(
    Effect.annotateSpans({
      "server.mode": serverConfig.mode,
      "server.port": serverConfig.port,
      "server.host": serverConfig.host ?? "default",
    }),
    Effect.withSpan("server.startup", { kind: "server", root: true }),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        const error = new ServerRuntimeStartupError({
          message: "Server runtime startup failed before command readiness.",
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: { at: new Date().toISOString() },
        }),
      );

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      yield* Effect.logDebug("startup phase: browser open check");
      yield* runStartupPhase("browser.open", maybeOpenBrowser);
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartupShape;
});

export const ServerRuntimeStartupLive = Layer.effect(
  ServerRuntimeStartup,
  makeServerRuntimeStartup,
);
