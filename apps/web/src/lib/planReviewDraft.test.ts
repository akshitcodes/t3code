import { describe, expect, it } from "vitest";

import {
  buildPlanReviewDraftPreview,
  canSubmitPlanReviewDraft,
  createPlanReviewDraft,
} from "./planReviewDraft";
import type { ChatMessage, ProposedPlan } from "../types";

function makeMessage(input: { id: string; role: ChatMessage["role"]; text: string }): ChatMessage {
  return {
    id: input.id as ChatMessage["id"],
    role: input.role,
    text: input.text,
    createdAt: "2026-04-13T10:00:00.000Z",
    streaming: false,
  };
}

function makeProposedPlan(planMarkdown: string): ProposedPlan {
  return {
    id: "plan-1" as ProposedPlan["id"],
    turnId: null,
    planMarkdown,
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
  };
}

describe("createPlanReviewDraft", () => {
  it("uses the first user message as the goal and the latest proposed plan as the plan", () => {
    const draft = createPlanReviewDraft({
      reviewerProvider: "codex",
      messages: [
        makeMessage({ id: "m1", role: "user", text: "Ship the login flow safely." }),
        makeMessage({ id: "m2", role: "assistant", text: "I will inspect the auth routes." }),
      ],
      proposedPlan: makeProposedPlan("# Login plan\n\n## Summary\n\n1. Add routes\n2. Add tests"),
      initialExtraContext: "Focus on rollout risk.",
    });

    expect(draft).toEqual({
      reviewerProvider: "codex",
      goalText: "Ship the login flow safely.",
      goalSourceLabel: "Auto-selected from the first user message",
      planText: "1. Add routes\n2. Add tests",
      planSourceLabel: "Auto-selected from the latest proposed plan",
      extraContext: "Focus on rollout risk.",
    });
  });

  it("falls back to the latest assistant message when there is no proposed plan", () => {
    const draft = createPlanReviewDraft({
      reviewerProvider: "claudeAgent",
      messages: [
        makeMessage({ id: "m1", role: "user", text: "Fix the reconnect bug." }),
        makeMessage({ id: "m2", role: "assistant", text: "Initial thought" }),
        makeMessage({
          id: "m3",
          role: "assistant",
          text: "Plan:\n1. Reproduce\n2. Patch reconnect",
        }),
      ],
      proposedPlan: null,
    });

    expect(draft.planText).toBe("Plan:\n1. Reproduce\n2. Patch reconnect");
    expect(draft.planSourceLabel).toBe("Auto-selected from the latest assistant message");
  });

  it("shows empty-state labels when the thread does not have enough content", () => {
    const draft = createPlanReviewDraft({
      reviewerProvider: "copilot",
      messages: [],
      proposedPlan: null,
    });

    expect(draft.goalText).toBe("");
    expect(draft.planText).toBe("");
    expect(draft.goalSourceLabel).toBe("No user message was found yet");
    expect(draft.planSourceLabel).toBe("No proposed plan or assistant message was found yet");
  });
});

describe("buildPlanReviewDraftPreview", () => {
  it("builds the same structured payload that gets sent to the reviewer", () => {
    expect(
      buildPlanReviewDraftPreview({
        goalText: "Ship the login flow safely.",
        planText: "1. Add routes\n2. Add tests",
        extraContext: "Focus on rollout risk.",
      }),
    ).toBe(`Goal:
Ship the login flow safely.

Proposed plan:
1. Add routes
2. Add tests

Extra context:
Focus on rollout risk.`);
  });
});

describe("canSubmitPlanReviewDraft", () => {
  it("requires both a goal and a plan", () => {
    expect(canSubmitPlanReviewDraft({ goalText: "Goal", planText: "Plan" })).toBe(true);
    expect(canSubmitPlanReviewDraft({ goalText: "Goal", planText: "   " })).toBe(false);
    expect(canSubmitPlanReviewDraft({ goalText: "   ", planText: "Plan" })).toBe(false);
  });
});
