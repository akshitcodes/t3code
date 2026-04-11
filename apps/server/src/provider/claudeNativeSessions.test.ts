import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  claudePermissionModeToInteractionMode,
  claudePermissionModeToRuntimeMode,
  claudeSessionToModelSelection,
  discoverClaudeNativeSessions,
  normalizeWorkspaceRootForLookup,
  readClaudeSessionIdFromResumeCursor,
  summarizeClaudeNativeSessionFile,
} from "./claudeNativeSessions.ts";

describe("claudeNativeSessions", () => {
  it.effect("summarizes a Claude native session file", () =>
    Effect.gen(function* () {
      const summary = summarizeClaudeNativeSessionFile(
        "C:\\Users\\akshit\\.claude\\projects\\sample\\11111111-1111-1111-1111-111111111111.jsonl",
        [
          JSON.stringify({
            type: "queue-operation",
            operation: "enqueue",
            timestamp: "2026-04-04T19:42:31.760Z",
            sessionId: "11111111-1111-1111-1111-111111111111",
          }),
          JSON.stringify({
            type: "user",
            timestamp: "2026-04-04T19:42:31.841Z",
            sessionId: "11111111-1111-1111-1111-111111111111",
            entrypoint: "claude-vscode",
            cwd: "c:\\Users\\akshit\\OneDrive\\Documents\\Projects\\college-placement-scraper",
            permissionMode: "plan",
            slug: "drifting-dreaming-whale",
            gitBranch: "HEAD",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Help me plan the placement scraper architecture.",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-04-04T19:42:32.100Z",
            sessionId: "11111111-1111-1111-1111-111111111111",
            cwd: "c:\\Users\\akshit\\OneDrive\\Documents\\Projects\\college-placement-scraper",
            message: {
              role: "assistant",
              model: "claude-opus-4-6-20251117",
              content: [{ type: "text", text: "Plan drafted." }],
            },
          }),
        ].join("\n"),
      );

      assert.deepStrictEqual(summary, {
        sessionId: "11111111-1111-1111-1111-111111111111",
        cwd: "c:\\Users\\akshit\\OneDrive\\Documents\\Projects\\college-placement-scraper",
        sourcePath:
          "C:\\Users\\akshit\\.claude\\projects\\sample\\11111111-1111-1111-1111-111111111111.jsonl",
        title: "Help me plan the placement scraper architecture.",
        createdAt: "2026-04-04T19:42:31.760Z",
        updatedAt: "2026-04-04T19:42:32.100Z",
        entrypoint: "claude-vscode",
        slug: "drifting-dreaming-whale",
        gitBranch: "HEAD",
        permissionMode: "plan",
        model: "claude-opus-4-6-20251117",
      });
    }),
  );

  it.effect("falls back to slug when the session has no meaningful user prompt", () =>
    Effect.gen(function* () {
      const summary = summarizeClaudeNativeSessionFile(
        "/tmp/22222222-2222-2222-2222-222222222222.jsonl",
        [
          JSON.stringify({
            type: "user",
            timestamp: "2026-04-04T19:38:31.373Z",
            sessionId: "22222222-2222-2222-2222-222222222222",
            entrypoint: "claude-vscode",
            cwd: "/workspace/demo",
            slug: "drifting-dreaming-whale",
            isMeta: true,
            message: {
              role: "user",
              content:
                "<local-command-caveat>Caveat: ignore local command output.</local-command-caveat>",
            },
          }),
        ].join("\n"),
      );

      assert.equal(summary?.title, "Drifting Dreaming Whale");
    }),
  );

  it.effect("discovers Claude native sessions from a projects directory", () =>
    Effect.tryPromise(async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-native-sessions-"));
      try {
        const firstProject = path.join(tempRoot, "project-a");
        const secondProject = path.join(tempRoot, "project-b");
        mkdirSync(firstProject, { recursive: true });
        mkdirSync(secondProject, { recursive: true });

        writeFileSync(
          path.join(firstProject, "33333333-3333-3333-3333-333333333333.jsonl"),
          JSON.stringify({
            type: "user",
            timestamp: "2026-04-01T10:00:00.000Z",
            sessionId: "33333333-3333-3333-3333-333333333333",
            cwd: "/workspace/alpha",
            message: {
              role: "user",
              content: [{ type: "text", text: "Alpha session" }],
            },
          }),
        );
        writeFileSync(
          path.join(secondProject, "44444444-4444-4444-4444-444444444444.jsonl"),
          JSON.stringify({
            type: "user",
            timestamp: "2026-04-02T10:00:00.000Z",
            sessionId: "44444444-4444-4444-4444-444444444444",
            cwd: "/workspace/beta",
            message: {
              role: "user",
              content: [{ type: "text", text: "Beta session" }],
            },
          }),
        );
        mkdirSync(path.join(secondProject, "subagents"), { recursive: true });
        writeFileSync(path.join(secondProject, "notes.txt"), "ignore");

        const discovered = await discoverClaudeNativeSessions(tempRoot);
        assert.deepStrictEqual(
          discovered.map((entry) => ({
            sessionId: entry.sessionId,
            title: entry.title,
            cwd: entry.cwd,
          })),
          [
            {
              sessionId: "44444444-4444-4444-4444-444444444444",
              title: "Beta session",
              cwd: "/workspace/beta",
            },
            {
              sessionId: "33333333-3333-3333-3333-333333333333",
              title: "Alpha session",
              cwd: "/workspace/alpha",
            },
          ],
        );
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("maps permission mode and model metadata into T3 shapes", () =>
    Effect.gen(function* () {
      assert.equal(claudePermissionModeToRuntimeMode("bypassPermissions"), "full-access");
      assert.equal(claudePermissionModeToRuntimeMode("plan"), "approval-required");
      assert.equal(claudePermissionModeToInteractionMode("plan"), "plan");
      assert.equal(claudePermissionModeToInteractionMode("default"), "default");
      assert.deepStrictEqual(claudeSessionToModelSelection("claude-opus-4-6-20251117"), {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      });
      assert.equal(
        readClaudeSessionIdFromResumeCursor({
          resume: "55555555-5555-5555-5555-555555555555",
        }),
        "55555555-5555-5555-5555-555555555555",
      );
      const normalized = normalizeWorkspaceRootForLookup("C:\\Users\\Akshit\\Project");
      assert.equal(
        normalized,
        process.platform === "win32" ? "c:\\users\\akshit\\project" : "C:\\Users\\Akshit\\Project",
      );
    }),
  );
});
