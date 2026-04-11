import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelSelection,
} from "@t3tools/contracts";

export interface ClaudeNativeSessionRecord {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sourcePath: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entrypoint?: string;
  readonly slug?: string;
  readonly gitBranch?: string;
  readonly permissionMode?: string;
  readonly model?: string;
}

type ClaudeMessageContentPart =
  | string
  | {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly content?: unknown;
    };

type ClaudeNativeSessionEvent = {
  readonly type?: unknown;
  readonly sessionId?: unknown;
  readonly timestamp?: unknown;
  readonly cwd?: unknown;
  readonly entrypoint?: unknown;
  readonly slug?: unknown;
  readonly gitBranch?: unknown;
  readonly permissionMode?: unknown;
  readonly isMeta?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly model?: unknown;
    readonly content?: unknown;
  };
};

const SESSION_FILE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function compareIso(left: string, right: string): number {
  return left.localeCompare(right);
}

function sanitizeTitleCandidate(value: string): string | undefined {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return undefined;
  }
  if (
    compact.startsWith("<command-name>") ||
    compact.startsWith("<local-command") ||
    compact.startsWith("<command-message>") ||
    compact.startsWith("<command-args>") ||
    compact.startsWith("Set model to ")
  ) {
    return undefined;
  }
  return compact;
}

function truncateTitle(value: string, max = 96): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join(" ");
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return sanitizeTitleCandidate(content);
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const part of content as ReadonlyArray<ClaudeMessageContentPart>) {
    if (typeof part === "string") {
      const text = sanitizeTitleCandidate(part);
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }
    if (part.type === "text") {
      const text = sanitizeTitleCandidate(asTrimmedString(part.text) ?? "");
      if (text) {
        parts.push(text);
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  return sanitizeTitleCandidate(parts.join(" "));
}

function sessionTitleFromSummary(input: {
  readonly firstUserText?: string;
  readonly slug?: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  const userText = input.firstUserText ? truncateTitle(input.firstUserText) : undefined;
  if (userText) {
    return userText;
  }
  if (input.slug) {
    return humanizeSlug(input.slug);
  }
  const cwdBase = path.basename(input.cwd);
  if (cwdBase.length > 0) {
    return `Claude ${cwdBase}`;
  }
  return `Claude ${input.sessionId.slice(0, 8)}`;
}

function toClaudeModelSelection(model: string | undefined): ModelSelection {
  const trimmed = asTrimmedString(model)?.toLowerCase();
  const canonical =
    (trimmed
      ? MODEL_SLUG_ALIASES_BY_PROVIDER.claudeAgent[trimmed] ?? trimmed
      : undefined) ?? DEFAULT_MODEL_BY_PROVIDER.claudeAgent;
  return {
    provider: "claudeAgent",
    model: canonical,
  };
}

export function normalizeWorkspaceRootForLookup(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function claudePermissionModeToRuntimeMode(
  permissionMode: string | undefined,
): "approval-required" | "full-access" {
  return permissionMode?.trim().toLowerCase() === "bypasspermissions"
    ? "full-access"
    : "approval-required";
}

export function claudePermissionModeToInteractionMode(
  permissionMode: string | undefined,
): "default" | "plan" {
  return permissionMode?.trim().toLowerCase() === "plan" ? "plan" : "default";
}

export function claudeSessionToModelSelection(model: string | undefined): ModelSelection {
  return toClaudeModelSelection(model);
}

export function readClaudeSessionIdFromResumeCursor(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    readonly resume?: unknown;
    readonly sessionId?: unknown;
  };
  return asTrimmedString(cursor.resume) ?? asTrimmedString(cursor.sessionId);
}

export function summarizeClaudeNativeSessionFile(
  filePath: string,
  fileContent: string,
): ClaudeNativeSessionRecord | null {
  const lines = fileContent
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const basename = path.basename(filePath, ".jsonl");
  let sessionId = SESSION_FILE_REGEX.test(path.basename(filePath)) ? basename : undefined;
  let cwd: string | undefined;
  let earliestTimestamp: string | undefined;
  let latestTimestamp: string | undefined;
  let firstUserText: string | undefined;
  let firstUserTextAt: string | undefined;
  let entrypoint: string | undefined;
  let slug: string | undefined;
  let gitBranch: string | undefined;
  let permissionMode: string | undefined;
  let model: string | undefined;

  for (const line of lines) {
    let parsed: ClaudeNativeSessionEvent;
    try {
      parsed = JSON.parse(line) as ClaudeNativeSessionEvent;
    } catch {
      continue;
    }

    const eventSessionId = asTrimmedString(parsed.sessionId);
    if (!sessionId && eventSessionId) {
      sessionId = eventSessionId;
    }

    const timestamp = asTrimmedString(parsed.timestamp);
    if (timestamp) {
      earliestTimestamp =
        !earliestTimestamp || compareIso(timestamp, earliestTimestamp) < 0
          ? timestamp
          : earliestTimestamp;
      latestTimestamp =
        !latestTimestamp || compareIso(timestamp, latestTimestamp) > 0 ? timestamp : latestTimestamp;
    }

    cwd = asTrimmedString(parsed.cwd) ?? cwd;
    entrypoint = asTrimmedString(parsed.entrypoint) ?? entrypoint;
    slug = asTrimmedString(parsed.slug) ?? slug;
    gitBranch = asTrimmedString(parsed.gitBranch) ?? gitBranch;
    permissionMode = asTrimmedString(parsed.permissionMode) ?? permissionMode;
    model = asTrimmedString(parsed.message?.model) ?? model;

    const role = asTrimmedString(parsed.message?.role);
    const isMeta = parsed.isMeta === true;
    if (role !== "user" || isMeta) {
      continue;
    }

    const text = extractTextFromContent(parsed.message?.content);
    if (!text) {
      continue;
    }

    const candidateAt = timestamp ?? "";
    if (
      !firstUserText ||
      !firstUserTextAt ||
      (candidateAt.length > 0 && compareIso(candidateAt, firstUserTextAt) < 0)
    ) {
      firstUserText = text;
      firstUserTextAt = candidateAt;
    }
  }

  if (!sessionId || !cwd || !latestTimestamp) {
    return null;
  }

  return {
    sessionId,
    cwd,
    sourcePath: filePath,
    title: sessionTitleFromSummary({
      cwd,
      sessionId,
      ...(firstUserText ? { firstUserText } : {}),
      ...(slug ? { slug } : {}),
    }),
    createdAt: earliestTimestamp ?? latestTimestamp,
    updatedAt: latestTimestamp,
    ...(entrypoint ? { entrypoint } : {}),
    ...(slug ? { slug } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(model ? { model } : {}),
  };
}

export async function discoverClaudeNativeSessions(
  projectsRoot: string,
): Promise<ReadonlyArray<ClaudeNativeSessionRecord>> {
  let projectEntries: ReadonlyArray<Dirent>;
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessions: ClaudeNativeSessionRecord[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }
    const projectPath = path.join(projectsRoot, projectEntry.name);
    const sessionEntries = await fs.readdir(projectPath, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isFile() || !SESSION_FILE_REGEX.test(sessionEntry.name)) {
        continue;
      }
      const sessionPath = path.join(projectPath, sessionEntry.name);
      const content = await fs.readFile(sessionPath, "utf8");
      const summary = summarizeClaudeNativeSessionFile(sessionPath, content);
      if (summary) {
        sessions.push(summary);
      }
    }
  }

  return sessions.toSorted(
    (left, right) =>
      compareIso(right.updatedAt, left.updatedAt) ||
      left.cwd.localeCompare(right.cwd) ||
      left.sessionId.localeCompare(right.sessionId),
  );
}
