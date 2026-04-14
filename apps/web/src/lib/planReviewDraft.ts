import type { ProviderKind } from "@t3tools/contracts";
import { buildStructuredPlanReviewPayload } from "@t3tools/shared/review";

import { stripDisplayedPlanMarkdown } from "../proposedPlan";
import type { ChatMessage, ProposedPlan } from "../types";

export interface PlanReviewDraftState {
  readonly reviewerProvider: ProviderKind;
  readonly goalText: string;
  readonly goalSourceLabel: string;
  readonly planText: string;
  readonly planSourceLabel: string;
  readonly extraContext: string;
}

function normalizeMessageText(message: ChatMessage | undefined): string {
  return message?.text.trim() ?? "";
}

function findFirstUserMessage(messages: ReadonlyArray<ChatMessage>): ChatMessage | undefined {
  return messages.find((message) => message.role === "user" && message.text.trim().length > 0);
}

function findLatestAssistantMessage(messages: ReadonlyArray<ChatMessage>): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.text.trim().length > 0) {
      return message;
    }
  }
  return undefined;
}

function normalizePlanText(proposedPlan: ProposedPlan): string {
  const displayedPlan = stripDisplayedPlanMarkdown(proposedPlan.planMarkdown).trim();
  return displayedPlan.length > 0 ? displayedPlan : proposedPlan.planMarkdown.trim();
}

export function createPlanReviewDraft(input: {
  readonly reviewerProvider: ProviderKind;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlan: ProposedPlan | null;
  readonly initialExtraContext?: string;
}): PlanReviewDraftState {
  const firstUserMessage = findFirstUserMessage(input.messages);
  const latestAssistantMessage = findLatestAssistantMessage(input.messages);
  const goalText = normalizeMessageText(firstUserMessage);
  const planText =
    input.proposedPlan !== null
      ? normalizePlanText(input.proposedPlan)
      : normalizeMessageText(latestAssistantMessage);

  return {
    reviewerProvider: input.reviewerProvider,
    goalText,
    goalSourceLabel:
      goalText.length > 0
        ? "Auto-selected from the first user message"
        : "No user message was found yet",
    planText,
    planSourceLabel:
      input.proposedPlan !== null
        ? "Auto-selected from the latest proposed plan"
        : planText.length > 0
          ? "Auto-selected from the latest assistant message"
          : "No proposed plan or assistant message was found yet",
    extraContext: input.initialExtraContext?.trim() ?? "",
  };
}

export function buildPlanReviewDraftPreview(input: {
  readonly goalText: string;
  readonly planText: string;
  readonly extraContext: string;
}): string {
  return buildStructuredPlanReviewPayload({
    goal: input.goalText,
    proposedPlan: input.planText,
    extraContext: input.extraContext,
  });
}

export function canSubmitPlanReviewDraft(input: {
  readonly goalText: string;
  readonly planText: string;
}): boolean {
  return input.goalText.trim().length > 0 && input.planText.trim().length > 0;
}
