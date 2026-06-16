import { useEffect, useId } from "react";

import { providerLabel } from "@t3tools/shared/review";

import type { PlanReviewDraftState } from "../lib/planReviewDraft";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

interface PlanReviewDialogProps {
  readonly open: boolean;
  readonly draft: PlanReviewDraftState | null;
  readonly previewText: string;
  readonly canSubmit: boolean;
  readonly isSubmitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDraftChange: (
    updates: Partial<Pick<PlanReviewDraftState, "goalText" | "planText" | "extraContext">>,
  ) => void;
  readonly onSubmit: () => void;
}

export function PlanReviewDialog({
  open,
  draft,
  previewText,
  canSubmit,
  isSubmitting,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: PlanReviewDialogProps) {
  const goalId = useId();
  const planId = useId();
  const extraContextId = useId();
  const previewId = useId();

  useEffect(() => {
    if (!open || !draft) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = document.getElementById(goalId);
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [draft, goalId, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSubmitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Review Request</DialogTitle>
          <DialogDescription>
            Check the draft before sending it. This preview is the exact payload the reviewer will
            receive.
          </DialogDescription>
        </DialogHeader>

        {draft ? (
          <DialogPanel className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Reviewer</Badge>
                <span className="text-sm font-medium text-foreground">
                  {providerLabel(draft.reviewerProvider)}
                </span>
              </div>

              <label htmlFor={goalId} className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Goal</span>
                <span className="text-xs text-muted-foreground">{draft.goalSourceLabel}</span>
                <Textarea
                  id={goalId}
                  value={draft.goalText}
                  onChange={(event) => onDraftChange({ goalText: event.target.value })}
                  placeholder="Describe what the source thread is trying to achieve."
                  spellCheck={false}
                  rows={4}
                  disabled={isSubmitting}
                />
              </label>

              <label htmlFor={planId} className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Proposed plan</span>
                <span className="text-xs text-muted-foreground">{draft.planSourceLabel}</span>
                <Textarea
                  id={planId}
                  value={draft.planText}
                  onChange={(event) => onDraftChange({ planText: event.target.value })}
                  placeholder="Paste or refine the plan that should be reviewed."
                  spellCheck={false}
                  rows={10}
                  disabled={isSubmitting}
                />
              </label>

              <label htmlFor={extraContextId} className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">Extra context</span>
                <span className="text-xs text-muted-foreground">
                  Optional notes for the reviewer, like risks or constraints to focus on.
                </span>
                <Textarea
                  id={extraContextId}
                  value={draft.extraContext}
                  onChange={(event) => onDraftChange({ extraContext: event.target.value })}
                  placeholder="Example: pay special attention to rollback safety and reconnect behavior."
                  spellCheck={false}
                  rows={5}
                  disabled={isSubmitting}
                />
              </label>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline">Preview</Badge>
                <span className="text-xs text-muted-foreground">
                  This is what the reviewer will see.
                </span>
              </div>
              <label htmlFor={previewId} className="sr-only">
                Review payload preview
              </label>
              <Textarea
                id={previewId}
                value={previewText}
                readOnly
                spellCheck={false}
                rows={20}
                className="font-mono text-[13px] leading-5"
              />
            </div>
          </DialogPanel>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={!draft || !canSubmit || isSubmitting}>
            {isSubmitting ? "Sending review..." : "Send to reviewer"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
