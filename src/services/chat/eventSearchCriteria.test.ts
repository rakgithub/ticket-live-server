import { describe, expect, it } from "vitest";
import { normalizeEventSearchIntent } from "./eventSearchCriteria.ts";

describe("normalizeEventSearchIntent", () => {
  it("keeps provided criteria and trims whitespace", () => {
    expect(
      normalizeEventSearchIntent({
        isEventSearch: true,
        text: "  jazz events ",
        location: " Berlin ",
      }),
    ).toEqual({ text: "jazz events", location: "Berlin" });
  });
});
