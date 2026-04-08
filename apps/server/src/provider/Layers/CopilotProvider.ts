import {
  CopilotClient,
  type CopilotClientOptions,
  type GetAuthStatusResponse,
  type ModelInfo,
} from "@github/copilot-sdk";
import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Data, Effect, Equal, Layer, Stream } from "effect";

import type { CopilotSettings } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings";
import { resolveCopilotCliPath } from "../copilotCliPath";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot";
import { CopilotProvider } from "../Services/CopilotProvider";

const PROVIDER = "copilot" as const;

class CopilotProbeError extends Data.TaggedError("CopilotProbeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

function copilotClientOptions(): CopilotClientOptions {
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
  };
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function toProbeError(cause: unknown, fallback: string): CopilotProbeError {
  return new CopilotProbeError({
    message: toMessage(cause, fallback),
    cause,
  });
}

function authMetadata(auth: GetAuthStatusResponse): Pick<ServerProviderAuth, "type" | "label"> {
  const label =
    auth.login && auth.host
      ? `${auth.login} @ ${auth.host}`
      : auth.login
        ? auth.login
        : auth.statusMessage;

  return {
    ...(auth.authType ? { type: auth.authType } : {}),
    ...(label ? { label } : {}),
  };
}

function toModelCapabilities(model: ModelInfo): ModelCapabilities {
  return {
    reasoningEffortLevels: (model.supportedReasoningEfforts ?? []).map((value) => ({
      value,
      label: value === "xhigh" ? "Extra High" : value.slice(0, 1).toUpperCase() + value.slice(1),
      ...(model.defaultReasoningEffort === value ? { isDefault: true } : {}),
    })),
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

function toServerProviderModel(model: ModelInfo): ServerProviderModel {
  return {
    slug: model.id,
    name: model.name,
    isCustom: false,
    capabilities: toModelCapabilities(model),
  };
}

const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.map((allSettings) => allSettings.providers.copilot),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const client = new CopilotClient(copilotClientOptions());
  const stopClient = Effect.tryPromise({
    try: () => client.stop(),
    catch: (cause) => toProbeError(cause, "Failed to stop GitHub Copilot SDK probe."),
  }).pipe(Effect.catch(() => Effect.void));

  return yield* Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => client.start(),
      catch: (cause) => toProbeError(cause, "Failed to start GitHub Copilot SDK probe."),
    });
    const status = yield* Effect.tryPromise({
      try: () => client.getStatus(),
      catch: (cause) => toProbeError(cause, "Failed to read GitHub Copilot status."),
    });
    const auth = yield* Effect.tryPromise({
      try: () => client.getAuthStatus(),
      catch: (cause) =>
        toProbeError(cause, "Failed to read GitHub Copilot authentication status."),
    });
    const listedModels = yield* Effect.tryPromise({
      try: () => client.listModels(),
      catch: (cause) => toProbeError(cause, "Failed to list GitHub Copilot models."),
    }).pipe(
      Effect.catch(() => Effect.succeed([] as Array<ModelInfo>)),
    );
    const models =
      listedModels.length > 0
        ? providerModelsFromSettings(
            listedModels.map(toServerProviderModel),
            PROVIDER,
            settings.customModels,
          )
        : fallbackModels;

    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: status.version,
        status: auth.isAuthenticated ? "ready" : "error",
        auth: {
          status: auth.isAuthenticated ? "authenticated" : "unauthenticated",
          ...authMetadata(auth),
        },
        ...(auth.isAuthenticated
          ? {}
          : {
              message:
                auth.statusMessage ??
                "GitHub Copilot is not authenticated. Sign in to GitHub Copilot and try again.",
            }),
      },
    });
  }).pipe(
    Effect.ensuring(stopClient),
    Effect.catch((error) =>
      Effect.succeed(
        buildServerProvider({
          provider: PROVIDER,
          enabled: true,
          checkedAt,
          models: fallbackModels,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: `Failed to start GitHub Copilot SDK probe: ${error.message}`,
          },
        }),
      ),
    ),
  );
});

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider: checkCopilotProviderStatus().pipe(Effect.provideService(ServerSettingsService, serverSettings)),
    });
  }),
);
