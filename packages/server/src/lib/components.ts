// Stateless component ids. A button or select menu carries its whole payload in
// its customId, so interactions still resolve after a bot restart — nothing is
// held in a collector that a restart would drop.

export const MAX_CUSTOM_ID = 100;

const PREFIX = "b2b";
const ACTION_PATTERN = /^[a-z][a-z0-9_]*$/;
const ARG_PATTERN = /^[A-Za-z0-9_-]+$/;

export type ComponentId = { action: string; args: string[] };

export function encodeId(action: string, ...args: (string | number)[]): string {
  if (!ACTION_PATTERN.test(action)) throw new Error(`Invalid component action: ${action}`);

  const parts = args.map(String);
  for (const arg of parts) {
    if (!ARG_PATTERN.test(arg)) throw new Error(`Invalid component arg: ${arg}`);
  }

  const id = [PREFIX, action, ...parts].join(":");
  if (id.length > MAX_CUSTOM_ID) {
    throw new Error(`Component id is ${id.length} chars, over Discord's ${MAX_CUSTOM_ID}`);
  }
  return id;
}

// Returns null for anything this bot did not write, so a foreign or legacy
// component id never reaches application code as if it were ours.
export function decodeId(id: string): ComponentId | null {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_CUSTOM_ID) return null;

  const [prefix, action, ...args] = id.split(":");
  if (prefix !== PREFIX || !action || !ACTION_PATTERN.test(action)) return null;
  for (const arg of args) {
    if (!ARG_PATTERN.test(arg)) return null;
  }

  return { action, args };
}
