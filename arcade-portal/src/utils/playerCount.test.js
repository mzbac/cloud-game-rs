import { parsePlayerCount } from "./playerCount";

describe("parsePlayerCount", () => {
  it("returns 0 for empty values", () => {
    expect(parsePlayerCount(undefined)).toBe(0);
    expect(parsePlayerCount(null)).toBe(0);
    expect(parsePlayerCount("")).toBe(0);
  });

  it("parses numeric values", () => {
    expect(parsePlayerCount(3)).toBe(3);
    expect(parsePlayerCount("3")).toBe(3);
    expect(parsePlayerCount(" 5 ")).toBe(5);
  });

  it("clamps negatives to 0", () => {
    expect(parsePlayerCount(-1)).toBe(0);
    expect(parsePlayerCount("-2")).toBe(0);
  });

  it("returns 0 for non-numbers", () => {
    expect(parsePlayerCount("nope")).toBe(0);
  });
});

