import { test, expect } from "bun:test";
import { commands } from "../commands";
import { EPHEMERAL_REPLIES, replyIsEphemeral, unclassifiedCommands } from "./ack";

test("every registered command has an acknowledgment policy", () => {
  const names = commands.map((command) => command.name);
  expect(unclassifiedCommands(names)).toEqual([]);
});

test("the policy never outlives the commands it describes", () => {
  const names = new Set(commands.map((command) => command.name));
  const stale = Object.keys(EPHEMERAL_REPLIES).filter((name) => !names.has(name));
  expect(stale).toEqual([]);
});

test("replyIsEphemeral reports the shared and private surfaces", () => {
  expect(replyIsEphemeral("queue")).toBe(false);
  expect(replyIsEphemeral("help")).toBe(true);
  expect(replyIsEphemeral("search")).toBe(true);
  expect(replyIsEphemeral("play")).toBe(false);
});

test("replyIsEphemeral defaults an unknown command to public", () => {
  expect(replyIsEphemeral("not-a-command")).toBe(false);
  expect(unclassifiedCommands(["not-a-command"])).toEqual(["not-a-command"]);
});
