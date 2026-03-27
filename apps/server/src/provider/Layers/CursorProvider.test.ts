import { describe, expect, it } from "vitest";

import {
  getCursorModelCapabilities,
  resolveCursorAgentModel,
  resolveCursorAcpModelId,
} from "./CursorProvider.ts";

describe("resolveCursorAcpModelId", () => {
  it("emits ACP model ids that match explicit Cursor ACP config values", () => {
    expect(resolveCursorAcpModelId("composer-2", { fastMode: true })).toBe("composer-2[fast=true]");
    expect(resolveCursorAcpModelId("gpt-5.4", undefined)).toBe("gpt-5.4");
    expect(
      resolveCursorAcpModelId("claude-opus-4-6", {
        reasoning: "high",
        thinking: true,
        contextWindow: "1m",
      }),
    ).toBe("claude-opus-4-6[effort=high,thinking=true,context=1m]");
    expect(resolveCursorAcpModelId("gpt-5.3-codex", undefined)).toBe(
      "gpt-5.3-codex[reasoning=medium,fast=false]",
    );
  });

  it("preserves unrecognized ACP model slugs instead of forcing bracket notation", () => {
    expect(resolveCursorAcpModelId("gpt-5.4-1m", undefined)).toBe("gpt-5.4-1m");
    expect(resolveCursorAcpModelId("auto", undefined)).toBe("auto");
    expect(resolveCursorAcpModelId("claude-4.6-opus", undefined)).toBe("claude-4.6-opus");
  });

  it("passes custom models through unchanged", () => {
    expect(resolveCursorAcpModelId("custom/internal-model", undefined)).toBe(
      "custom/internal-model",
    );
  });
});

describe("getCursorModelCapabilities", () => {
  it("resolves capabilities from canonical cursor base slugs", () => {
    expect(getCursorModelCapabilities("gpt-5.4").contextWindowOptions).toEqual([
      { value: "272k", label: "272k", isDefault: true },
      { value: "1m", label: "1M" },
    ]);
    expect(getCursorModelCapabilities("claude-opus-4-6").supportsThinkingToggle).toBe(true);
  });
});

describe("resolveCursorAgentModel", () => {
  it("maps canonical base slugs onto agent CLI model ids", () => {
    expect(resolveCursorAgentModel("composer-2", { fastMode: true })).toBe("composer-2-fast");
    expect(resolveCursorAgentModel("gpt-5.3-codex", { reasoning: "xhigh" })).toBe(
      "gpt-5.3-codex-xhigh",
    );
    expect(
      resolveCursorAgentModel("gpt-5.4", {
        reasoning: "medium",
        fastMode: true,
        contextWindow: "272k",
      }),
    ).toBe("gpt-5.4-medium-fast");
    expect(resolveCursorAgentModel("claude-opus-4-6", { thinking: true })).toBe(
      "claude-4.6-opus-high-thinking",
    );
    expect(resolveCursorAgentModel("auto", undefined)).toBe("auto");
  });

  it("passes custom agent model ids through unchanged", () => {
    expect(resolveCursorAgentModel("gpt-5.4-mini-medium", undefined)).toBe("gpt-5.4-mini-medium");
    expect(resolveCursorAgentModel("custom/internal-model", undefined)).toBe(
      "custom/internal-model",
    );
  });
});
