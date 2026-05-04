import { describe, expect, it } from "vitest";
import { EventId } from "@t3tools/contracts";

import {
  buildStructuredPlanReviewPayload,
  buildPlanReviewFeedbackMessage,
  buildPlanReviewIterationRequestPrompt,
  buildPlanReviewRequestPrompt,
  buildPlanReviewThreadTitle,
  findLatestActivePlanReview,
  findLinkedPlanReviewThread,
  findPendingPlanReviewRequest,
  parsePlanReviewDecision,
  PLAN_REVIEW_COMPLETED_ACTIVITY_KIND,
  PLAN_REVIEW_FINISHED_ACTIVITY_KIND,
  PLAN_REVIEW_LINK_ACTIVITY_KIND,
  PLAN_REVIEW_REQUESTED_ACTIVITY_KIND,
} from "./review.js";

describe("review helpers", () => {
  it("builds a reviewer thread title", () => {
    expect(buildPlanReviewThreadTitle("Ship auth flow", "codex")).toBe(
      "Review: Ship auth flow (Codex)",
    );
  });

  it("builds a structured review request prompt", () => {
    const prompt = buildPlanReviewRequestPrompt({
      payload: "Goal: implement login flow\n\nPlan:\n1. Add routes",
    });

    expect(prompt).toContain("User-provided review payload:");
    expect(prompt).toContain("DECISION: update-plan");
    expect(prompt).toContain("After that, write the rest of the review naturally");
  });

  it("builds a structured review payload for the reviewer", () => {
    expect(
      buildStructuredPlanReviewPayload({
        goal: "Implement login flow",
        proposedPlan: "1. Add routes\n2. Add tests",
        extraContext: "We need to preserve the current API.",
      }),
    ).toBe(`Goal:
Implement login flow

Proposed plan:
1. Add routes
2. Add tests

Extra context:
We need to preserve the current API.`);
  });

  it("omits extra context when it is empty", () => {
    expect(
      buildStructuredPlanReviewPayload({
        goal: "Implement login flow",
        proposedPlan: "1. Add routes",
        extraContext: "   ",
      }),
    ).toBe(`Goal:
Implement login flow

Proposed plan:
1. Add routes`);
  });

  it("builds a follow-up review prompt for another iteration", () => {
    const prompt = buildPlanReviewIterationRequestPrompt({
      latestSourceResponse: "Updated plan:\n1. Add rollback\n2. Add smoke tests",
    });

    expect(prompt).toContain("The source agent replied to your review. Review it again.");
    expect(prompt).toContain("DECISION must be the first line:");
    expect(prompt).toContain("Source agent reply:");
  });

  it("parses the required decision line from a natural review", () => {
    expect(
      parsePlanReviewDecision(`
DECISION: update-plan

The sequencing is mostly sound, but it is missing rollback planning.

- Add a rollback step.
- Call out deployment ordering.
`),
    ).toEqual({
      decision: "update-plan",
      body: `DECISION: update-plan

The sequencing is mostly sound, but it is missing rollback planning.

- Add a rollback step.
- Call out deployment ordering.`,
    });
  });

  it("builds a source-thread feedback prompt from parsed review data", () => {
    const feedback = buildPlanReviewFeedbackMessage({
      reviewerProvider: "codex",
      review: {
        decision: "update-plan",
        body: `DECISION: update-plan

Missing rollback plan.`,
      },
    });

    expect(feedback).toContain("[Automated external review from Codex]");
    expect(feedback).toContain("Analyze this review neutrally");
    expect(feedback).toContain("Reviewer decision: update-plan");
    expect(feedback).toContain("Missing rollback plan.");
  });

  it("finds the latest linked review thread for a source thread", () => {
    expect(
      findLinkedPlanReviewThread(
        [
          {
            id: EventId.make("evt-link"),
            tone: "info",
            kind: PLAN_REVIEW_LINK_ACTIVITY_KIND,
            summary: "Linked review thread",
            payload: {
              role: "source",
              linkedThreadId: "thread-review",
              reviewerProvider: "codex",
            },
            turnId: null,
            createdAt: "2026-04-06T10:00:00.000Z",
          },
        ],
        "source",
        "codex",
      ),
    ).toEqual({
      role: "source",
      linkedThreadId: "thread-review",
      reviewerProvider: "codex",
    });
  });

  it("ignores completed review requests when finding pending review state", () => {
    expect(
      findPendingPlanReviewRequest([
        {
          id: EventId.make("evt-request"),
          tone: "info",
          kind: PLAN_REVIEW_REQUESTED_ACTIVITY_KIND,
          summary: "Review requested",
          payload: {
            reviewId: "review-1",
            sourceThreadId: "thread-source",
            reviewerThreadId: "thread-review",
            reviewerProvider: "codex",
            requestPrompt: "Review this plan",
            rootRequestPrompt: "Review this plan",
            round: 1,
          },
          turnId: null,
          createdAt: "2026-04-06T10:00:00.000Z",
        },
        {
          id: EventId.make("evt-complete"),
          tone: "info",
          kind: PLAN_REVIEW_COMPLETED_ACTIVITY_KIND,
          summary: "Review completed",
          payload: {
            reviewId: "review-1",
          },
          turnId: null,
          createdAt: "2026-04-06T10:01:00.000Z",
        },
      ]),
    ).toBeNull();
  });

  it("finds the latest active review session until it is finished", () => {
    expect(
      findLatestActivePlanReview([
        {
          id: EventId.make("evt-request"),
          tone: "info",
          kind: PLAN_REVIEW_REQUESTED_ACTIVITY_KIND,
          summary: "Review requested",
          payload: {
            reviewId: "review-1",
            sourceThreadId: "thread-source",
            reviewerThreadId: "thread-review",
            reviewerProvider: "codex",
            requestPrompt: "Round 1 payload",
            rootRequestPrompt: "Original payload",
            round: 1,
          },
          turnId: null,
          createdAt: "2026-04-06T10:00:00.000Z",
        },
        {
          id: EventId.make("evt-complete"),
          tone: "info",
          kind: PLAN_REVIEW_COMPLETED_ACTIVITY_KIND,
          summary: "Review completed",
          payload: {
            reviewId: "review-1",
            sourceThreadId: "thread-source",
            reviewerThreadId: "thread-review",
            reviewerProvider: "codex",
            requestPrompt: "Round 1 payload",
            rootRequestPrompt: "Original payload",
            round: 1,
            decision: "update-plan",
            assistantMessageId: "msg-review-1",
          },
          turnId: null,
          createdAt: "2026-04-06T10:01:00.000Z",
        },
      ]),
    ).toEqual({
      reviewId: "review-1",
      sourceThreadId: "thread-source",
      reviewerThreadId: "thread-review",
      reviewerProvider: "codex",
      requestPrompt: "Round 1 payload",
      rootRequestPrompt: "Original payload",
      round: 1,
      status: "completed",
      decision: "update-plan",
      assistantMessageId: "msg-review-1",
      createdAt: "2026-04-06T10:01:00.000Z",
    });

    expect(
      findLatestActivePlanReview([
        {
          id: EventId.make("evt-complete"),
          tone: "info",
          kind: PLAN_REVIEW_COMPLETED_ACTIVITY_KIND,
          summary: "Review completed",
          payload: {
            reviewId: "review-1",
            sourceThreadId: "thread-source",
            reviewerThreadId: "thread-review",
            reviewerProvider: "codex",
            requestPrompt: "Round 1 payload",
            rootRequestPrompt: "Original payload",
            round: 1,
            decision: "go-forward",
          },
          turnId: null,
          createdAt: "2026-04-06T10:01:00.000Z",
        },
        {
          id: EventId.make("evt-finished"),
          tone: "info",
          kind: PLAN_REVIEW_FINISHED_ACTIVITY_KIND,
          summary: "Review finished",
          payload: {
            reviewerThreadId: "thread-review",
            reviewerProvider: "codex",
          },
          turnId: null,
          createdAt: "2026-04-06T10:02:00.000Z",
        },
      ]),
    ).toBeNull();
  });
});
