import { describe, expect, it } from "vitest";

import { shouldRunTerminalPerfInteractions } from "./perfConfig";

describe("shouldRunTerminalPerfInteractions", () => {
  it("defaults to enabled outside CI when env is unset", () => {
    expect(shouldRunTerminalPerfInteractions({ CI: "false" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: "0" })).toBe(true);
    expect(shouldRunTerminalPerfInteractions({ CI: undefined })).toBe(true);
  });

  it("defaults to disabled in CI when env is unset", () => {
    expect(shouldRunTerminalPerfInteractions({ CI: "true" })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: "TRUE" })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: "1" })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: " yes " })).toBe(false);
    expect(shouldRunTerminalPerfInteractions({ CI: "on" })).toBe(false);
  });

  it("supports explicit true values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "1",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " true ",
        CI: "true",
      }),
    ).toBe(true);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "TRUE",
        CI: "true",
      }),
    ).toBe(true);
  });

  it("supports explicit false values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "0",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: " false ",
        CI: "false",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "FALSE",
        CI: "false",
      }),
    ).toBe(false);
  });

  it("falls back to CI-based default for unknown values", () => {
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "maybe",
        CI: "true",
      }),
    ).toBe(false);
    expect(
      shouldRunTerminalPerfInteractions({
        T3CODE_DESKTOP_PERF_RUN_TERMINAL: "maybe",
        CI: "false",
      }),
    ).toBe(true);
  });
});
