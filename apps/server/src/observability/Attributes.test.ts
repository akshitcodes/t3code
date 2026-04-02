import { assert, describe, it } from "@effect/vitest";

import { compactTraceAttributes } from "./Attributes.ts";

describe("Attributes", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });
});
