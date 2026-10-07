import { test, expect } from "bun:test";
import { MAX_CUSTOM_ID, decodeId, encodeId } from "./components";

test("encodeId: renders the prefix, action, and args", () => {
  expect(encodeId("q_next", "123456789012345678", 2)).toBe("b2b:q_next:123456789012345678:2");
});

test("encodeId: an action with no args has no trailing separator", () => {
  expect(encodeId("q_refresh")).toBe("b2b:q_refresh");
});

test("decodeId: round-trips every shape the UI encodes", () => {
  expect(decodeId(encodeId("q_refresh"))).toEqual({ action: "q_refresh", args: [] });
  expect(decodeId(encodeId("q_next", "123456789012345678", 3))).toEqual({
    action: "q_next",
    args: ["123456789012345678", "3"],
  });
  expect(decodeId(encodeId("a_approve", "123456789012345678"))).toEqual({
    action: "a_approve",
    args: ["123456789012345678"],
  });
});

// Component ids are the only state a button carries across a bot restart, so an
// id we did not write must decode to null instead of throwing inside a handler.
test("decodeId: rejects ids this bot did not write", () => {
  expect(decodeId("other:q_next")).toBeNull();
  expect(decodeId("b2b")).toBeNull();
  expect(decodeId("B2B:q_next")).toBeNull();
  expect(decodeId("")).toBeNull();
  expect(decodeId("b2b:")).toBeNull();
  expect(decodeId("b2b:q_next:")).toBeNull();
  expect(decodeId("b2b:q_next::2")).toBeNull();
});

test("decodeId: rejects an action outside the action charset", () => {
  expect(decodeId("b2b:q next")).toBeNull();
  expect(decodeId("b2b:q.next")).toBeNull();
  expect(decodeId("b2b:q_next;drop")).toBeNull();
});

test("decodeId: rejects args outside the arg charset", () => {
  expect(decodeId("b2b:q_next:../../etc/passwd")).toBeNull();
  expect(decodeId("b2b:q_next:über")).toBeNull();
  expect(decodeId("b2b:q_next:a b")).toBeNull();
});

test("encodeId: rejects an arg that would break the separator", () => {
  expect(() => encodeId("q_next", "1:2")).toThrow();
});

test("encodeId: rejects an action that is not a plain identifier", () => {
  expect(() => encodeId("q next")).toThrow();
  expect(() => encodeId("")).toThrow();
});

// Discord rejects the whole component if the id exceeds 100 characters, so an
// over-long id must fail loudly here rather than silently in a guild.
test("encodeId: refuses to build an id Discord would reject", () => {
  const arg = "1".repeat(MAX_CUSTOM_ID - "b2b:p_skip:".length);
  expect(encodeId("p_skip", arg).length).toBe(MAX_CUSTOM_ID);
  expect(() => encodeId("p_skip", `${arg}1`)).toThrow();
});

test("encodeId: a generated id always survives its own decoder", () => {
  const id = encodeId("q_vote", "123456789012345678", 12);
  expect(id.length).toBeLessThanOrEqual(MAX_CUSTOM_ID);
  expect(decodeId(id)).toEqual({ action: "q_vote", args: ["123456789012345678", "12"] });
});
