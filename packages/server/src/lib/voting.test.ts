import { test, expect } from "bun:test";
import { skipThreshold } from "./voting";

test("skipThreshold: floor of 1 when nobody is present", () => {
  expect(skipThreshold(0)).toBe(1);
});

test("skipThreshold: simple majority, rounded up", () => {
  expect(skipThreshold(1)).toBe(1);
  expect(skipThreshold(2)).toBe(1);
  expect(skipThreshold(3)).toBe(2);
  expect(skipThreshold(4)).toBe(2);
  expect(skipThreshold(5)).toBe(3);
  expect(skipThreshold(10)).toBe(5);
});
