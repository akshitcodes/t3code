import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { type Schema } from "effect";

import { toJsonSchemaObject } from "@t3tools/shared/schemaJson";

const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export function buildJsonSchemaDocument(
  schema: Schema.Top,
  options: {
    readonly title: string;
    readonly description: string;
  },
): Record<string, unknown> {
  const jsonSchema = toJsonSchemaObject(schema);
  if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
    throw new Error(
      `${options.title} JSON schema must be an object or array JSON schema document.`,
    );
  }

  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    title: options.title,
    description: options.description,
    ...jsonSchema,
  };
}

export const asJsonSchemaRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export const getJsonSchemaProperty = (
  schema: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> | null => {
  const properties = asJsonSchemaRecord(schema.properties);
  return properties ? asJsonSchemaRecord(properties[propertyName]) : null;
};

export const getNullableJsonSchemaBranch = (
  schema: Record<string, unknown> | null,
): Record<string, unknown> | null => {
  if (!schema) {
    return null;
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (!anyOf) {
    return schema;
  }

  for (const entry of anyOf) {
    const branch = asJsonSchemaRecord(entry);
    if (!branch || branch.type === "null") {
      continue;
    }
    return branch;
  }

  return null;
};

export const getJsonSchemaAnyOfBranches = (
  schema: Record<string, unknown> | null,
): ReadonlyArray<Record<string, unknown>> => {
  if (!schema || !Array.isArray(schema.anyOf)) {
    return [];
  }

  return schema.anyOf
    .map(asJsonSchemaRecord)
    .filter(
      (branch): branch is Record<string, unknown> => branch !== null && branch.type !== "null",
    );
};

export const setJsonSchemaDescription = (
  schema: Record<string, unknown> | null,
  description: string,
): void => {
  if (!schema) {
    return;
  }
  schema.description = description;
};

function writeJsonFileIfChanged(filePath: string, document: Record<string, unknown>): boolean {
  const nextContent = `${JSON.stringify(document, null, 2)}\n`;
  const previousContent = (() => {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  })();

  if (previousContent === nextContent) {
    return false;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, nextContent);
  return true;
}

export function writeJsonSchemaArtifacts(options: {
  readonly rootDir?: string;
  readonly version?: string;
  readonly latestRelativePath: string;
  readonly getVersionedRelativePath: (version: string) => string;
  readonly document: Record<string, unknown>;
}): {
  readonly changed: boolean;
} {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const latestChanged = writeJsonFileIfChanged(
    resolve(rootDir, options.latestRelativePath),
    options.document,
  );
  let changed = latestChanged;

  if (options.version && latestChanged) {
    changed =
      writeJsonFileIfChanged(
        resolve(rootDir, options.getVersionedRelativePath(options.version)),
        options.document,
      ) || changed;
  }

  return { changed };
}
