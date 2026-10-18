import { test, expect } from "bun:test";
import { createInfoCache } from "./infoCache";

// A hand-driven clock so expiry is tested without sleeping.
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("take returns a stored entry", () => {
  const cache = createInfoCache();
  cache.set("https://a", '{"id":"a"}');
  expect(cache.take("https://a")).toBe('{"id":"a"}');
});

test("take misses an unknown url", () => {
  const cache = createInfoCache();
  expect(cache.take("https://missing")).toBeNull();
});

test("take consumes the entry: a second take misses", () => {
  const cache = createInfoCache();
  cache.set("https://a", "{}");
  expect(cache.take("https://a")).toBe("{}");
  expect(cache.take("https://a")).toBeNull();
  expect(cache.size).toBe(0);
});

test("an entry past its TTL is a miss", () => {
  const c = clock();
  const cache = createInfoCache({ ttlMs: 100, now: c.now });
  cache.set("https://a", "{}");
  c.advance(99);
  expect(cache.take("https://a")).toBe("{}");

  cache.set("https://b", "{}");
  c.advance(100);
  expect(cache.take("https://b")).toBeNull();
});

test("expired entries are evicted on the next write", () => {
  const c = clock();
  const cache = createInfoCache({ ttlMs: 100, now: c.now });
  cache.set("https://a", "{}");
  c.advance(150);
  cache.set("https://b", "{}");
  expect(cache.size).toBe(1);
});

test("over capacity, the oldest entry is evicted first", () => {
  const cache = createInfoCache({ maxEntries: 2 });
  cache.set("https://a", "a");
  cache.set("https://b", "b");
  cache.set("https://c", "c");
  expect(cache.size).toBe(2);
  expect(cache.take("https://a")).toBeNull();
  expect(cache.take("https://b")).toBe("b");
  expect(cache.take("https://c")).toBe("c");
});

test("overwriting a url refreshes it as the newest entry", () => {
  const cache = createInfoCache({ maxEntries: 2 });
  cache.set("https://a", "a1");
  cache.set("https://b", "b");
  cache.set("https://a", "a2");
  cache.set("https://c", "c");
  expect(cache.take("https://b")).toBeNull();
  expect(cache.take("https://a")).toBe("a2");
});
