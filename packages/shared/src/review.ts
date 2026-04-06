import { type OrchestrationThreadActivity, type ProviderKind, ThreadId } from "@t3tools/contracts";

export const PLAN_REVIEW_LINK_ACTIVITY_KIND = "plan-review.linked";
export const PLAN_REVIEW_REQUESTED_ACTIVITY_KIND = "plan-review.requested";
export const PLAN_REVIEW_COMPLETED_ACTIVITY_KIND = "plan-review.completed";
export const PLAN_REVIEW_FAILED_ACTIVITY_KIND = "plan-review.failed";

export interface LinkedPlanReviewThread {
  readonly role: "source" | "reviewer";
  readonly linkedThreadId: ThreadId;
  readonly reviewerProvider: ProviderKind;
}

export interface PendingPlanReviewRequest {
  readonly reviewId: string;
  readonly sourceThreadId: ThreadId;
  readonly reviewerThreadId: ThreadId;
  readonly reviewerProvider: ProviderKind;
  readonly requestPrompt: string;
  readonly createdAt: string;
}

export interface ParsedPlanReviewDecision {
  readonly decision: "update-plan" | "go-forward";
  readonly body: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compareActivitiesByOrder(
  left: Pick<OrchestrationThreadActivity, "sequence" | "createdAt" | "id">,
  right: Pick<OrchestrationThreadActivity, "sequence" | "createdAt" | "id">,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function parseProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" ? value : null;
}

export function providerLabel(provider: ProviderKind): "Codex" | "Claude" {
  return provider === "codex" ? "Codex" : "Claude";
}

export function buildPlanReviewThreadTitle(
  sourceTitle: string,
  reviewerProvider: ProviderKind,
): string {
  return `Review: ${sourceTitle} (${providerLabel(reviewerProvider)})`;
}

export function buildPlanReviewRequestPrompt(input: { readonly payload: string }): string {
  return [
    "You are reviewing another agent's plan.",
    "",
    "User-provided review payload:",
    "---",
    input.payload.trim(),
    "---",
    "",
    "Review the plan critically for correctness, sequencing, missing steps, hidden risks, and unnecessary complexity.",
    "",
    "You must include exactly one decision line at the top in this format:",
    "",
    "DECISION: update-plan",
    "or",
    "DECISION: go-forward",
    "",
    "After that, write the rest of the review naturally in your own words.",
  ].join("\n");
}

export function parsePlanReviewDecision(text: string): ParsedPlanReviewDecision | null {
  const match = /^\s*DECISION:\s*(update-plan|go-forward)\s*$/im.exec(text);
  if (!match?.[1]) {
    return null;
  }

  const decision = match[1].toLowerCase() === "go-forward" ? "go-forward" : "update-plan";
  return {
    decision,
    body: text.trim(),
  };
}

export function buildPlanReviewFeedbackMessage(input: {
  readonly reviewerProvider: ProviderKind;
  readonly review: ParsedPlanReviewDecision;
}): string {
  return [
    `[Automated external review from ${providerLabel(input.reviewerProvider)}]`,
    "",
    "Your plan got reviewed by another agent. Analyze this review neutrally; do not assume it is correct. Accept or reject points based on the task and evidence.",
    "",
    `Reviewer decision: ${input.review.decision}`,
    "",
    "Reviewer output:",
    input.review.body,
  ].join("\n");
}

export function findLinkedPlanReviewThread(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  role: LinkedPlanReviewThread["role"],
  reviewerProvider?: ProviderKind,
): LinkedPlanReviewThread | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder).toReversed();

  for (const activity of ordered) {
    if (activity.kind !== PLAN_REVIEW_LINK_ACTIVITY_KIND) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (!payload || payload.role !== role) {
      continue;
    }
    const linkedThreadId = asTrimmedString(payload.linkedThreadId);
    const parsedReviewerProvider = parseProviderKind(payload.reviewerProvider);
    if (!linkedThreadId || !parsedReviewerProvider) {
      continue;
    }
    if (reviewerProvider && parsedReviewerProvider !== reviewerProvider) {
      continue;
    }
    return {
      role,
      linkedThreadId: ThreadId.makeUnsafe(linkedThreadId),
      reviewerProvider: parsedReviewerProvider,
    };
  }

  return null;
}

export function findPendingPlanReviewRequest(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingPlanReviewRequest | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder).toReversed();
  const terminalReviewIds = new Set<string>();

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const reviewId = asTrimmedString(payload?.reviewId);
    if (!reviewId) {
      continue;
    }
    if (
      activity.kind === PLAN_REVIEW_COMPLETED_ACTIVITY_KIND ||
      activity.kind === PLAN_REVIEW_FAILED_ACTIVITY_KIND
    ) {
      terminalReviewIds.add(reviewId);
      continue;
    }
    if (activity.kind !== PLAN_REVIEW_REQUESTED_ACTIVITY_KIND || terminalReviewIds.has(reviewId)) {
      continue;
    }

    const sourceThreadId = asTrimmedString(payload?.sourceThreadId);
    const reviewerThreadId = asTrimmedString(payload?.reviewerThreadId);
    const reviewerProvider = parseProviderKind(payload?.reviewerProvider);
    const requestPrompt = asTrimmedString(payload?.requestPrompt);
    if (!sourceThreadId || !reviewerThreadId || !reviewerProvider || !requestPrompt) {
      continue;
    }

    return {
      reviewId,
      sourceThreadId: ThreadId.makeUnsafe(sourceThreadId),
      reviewerThreadId: ThreadId.makeUnsafe(reviewerThreadId),
      reviewerProvider,
      requestPrompt,
      createdAt: activity.createdAt,
    };
  }

  return null;
}
