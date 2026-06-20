import { test, expect } from "bun:test";
import { encodeJwt, decodeJwt } from "./jwt";

const SECRET = "test-secret-at-least-32-chars-long-aaaa";

test("encode/decode roundtrip preserves the payload", async () => {
  const token = await encodeJwt({ sub: "123", tv: 0 }, SECRET, 3600);
  const payload = await decodeJwt(token, SECRET);
  expect(payload?.sub).toBe("123");
  expect(payload?.tv).toBe(0);
});

test("rejects a token signed with a different secret", async () => {
  const token = await encodeJwt({ sub: "123" }, SECRET, 3600);
  expect(
    await decodeJwt(token, "another-secret-at-least-32-chars-bbbb")
  ).toBeNull();
});

test("rejects a tampered payload", async () => {
  const token = await encodeJwt({ sub: "123" }, SECRET, 3600);
  const [h, , s] = token.split(".");
  const forged = `${h}.${btoa(
    JSON.stringify({ sub: "admin", exp: 9999999999 })
  )}.${s}`;
  expect(await decodeJwt(forged, SECRET)).toBeNull();
});

test("rejects an expired token", async () => {
  const token = await encodeJwt({ sub: "123" }, SECRET, -1);
  expect(await decodeJwt(token, SECRET)).toBeNull();
});

test("rejects alg:none / non-HS256 header", async () => {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = btoa(JSON.stringify({ sub: "admin", exp: 9999999999 }));
  expect(await decodeJwt(`${header}.${body}.`, SECRET)).toBeNull();
});

test("rejects malformed tokens", async () => {
  expect(await decodeJwt("garbage", SECRET)).toBeNull();
  expect(await decodeJwt("", SECRET)).toBeNull();
  expect(await decodeJwt("a.b", SECRET)).toBeNull();
});
