import { expect, test } from "bun:test";
import { testTimeScale } from "../src/main/test-scale";

test("a test or source build takes the run's scale, a released app never does", () => {
  expect(testTimeScale({ MOSS_ACCEPT_TIME_SCALE: "3" }, false)).toBe(3);
  expect(testTimeScale({ MOSS_ACCEPT_TIME_SCALE: "3" }, true)).toBe(1);
  expect(testTimeScale({}, false)).toBe(1);
  for (const bad of ["0", "11", "abc", "", "-2", "NaN"]) expect(testTimeScale({ MOSS_ACCEPT_TIME_SCALE: bad }, false)).toBe(1);
});
