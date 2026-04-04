import { Schema } from "effect";

export class TerminalProcessInspectionError extends Schema.TaggedErrorClass<TerminalProcessInspectionError>()(
  "TerminalProcessInspectionError",
  {
    operation: Schema.String,
    terminalPid: Schema.Int,
    command: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.operation} failed for terminal pid ${this.terminalPid}: ${this.detail}`;
  }
}

export class WebPortInspectionError extends Schema.TaggedErrorClass<WebPortInspectionError>()(
  "WebPortInspectionError",
  {
    port: Schema.Int,
    host: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Web port probe failed for ${this.host}:${this.port}: ${this.detail}`;
  }
}

export type TerminalInspectorError = TerminalProcessInspectionError | WebPortInspectionError;
