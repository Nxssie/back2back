// Minimal HS256 JWT (sign/verify) over the Web Crypto API. Verification is
// constant-time (crypto.subtle.verify) and the header alg is validated, so the
// only accepted algorithm is HS256 — no alg-confusion or alg:none bypass.

function b64decodeToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage
  );
}

export async function encodeJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(
    JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })
  );
  const key = await hmacKey(secret, ["sign"]);
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${header}.${body}`)
    )
  );
  const signature = btoa(String.fromCharCode(...sigBytes));
  return `${header}.${body}.${signature}`;
}

export async function decodeJwt(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  try {
    const [header, body, signature] = token.split(".");
    if (!header || !body || !signature) return null;
    // Validate the header explicitly — only HS256 is ever accepted.
    const head = JSON.parse(atob(header));
    if (head?.alg !== "HS256" || head?.typ !== "JWT") return null;
    const key = await hmacKey(secret, ["verify"]);
    // Constant-time verification, not a string compare of recomputed signatures.
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      b64decodeToBytes(signature),
      new TextEncoder().encode(`${header}.${body}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    // Require a valid, unexpired exp (also retires legacy never-expiring tokens).
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}
