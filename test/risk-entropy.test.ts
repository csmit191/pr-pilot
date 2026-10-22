import { describe, expect, it } from "vitest";
import { shannonEntropy } from "../src/risk/entropy.js";

describe("shannonEntropy", () => {
  it("is 0 for empty and single-symbol strings", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });

  it("matches hand-computed values", () => {
    expect(shannonEntropy("ab")).toBe(1);
    expect(shannonEntropy("abcd")).toBe(2);
    expect(shannonEntropy("aabb")).toBe(1);
  });

  it("scores random-looking text far above identifiers and hex hashes", () => {
    const random = shannonEntropy("k8Zq2Vx9Lm4Tn7Ws1Yb6Hd3Fg5Jr0Pc8Ua2Ne4Qo");
    const identifier = shannonEntropy("thisIsAVeryLongDescriptiveVariableName2");
    const sha = shannonEntropy("9fceb02d0ae598e95dc970b74767f19372d61af8");
    expect(random).toBeGreaterThan(4.5);
    expect(identifier).toBeLessThan(4.5);
    expect(sha).toBeLessThan(4.5);
  });
});
