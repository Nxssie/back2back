import { test, expect } from "bun:test";
import { commands } from "../commands";
import { EPHEMERAL_REPLIES, ephemeralNotice, replyIsEphemeral, unclassifiedCommands } from "./ack";

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

// The table itself, pinned entry by entry: public commands must not silently
// drift to ephemeral (or the reverse) when a command is added or renamed, since
// the defer style above is the only thing fixing each reply's visibility.
test("the policy table pins each command's public vs ephemeral reply", () => {
  expect(EPHEMERAL_REPLIES).toEqual({
    play: false,
    listen: false,
    stop: false,
    queue: false,
    reset: false,
    room: false,
    search: true,
    skip: true,
    lyrics: true,
    admin: true,
    help: true,
  });
});

// A fake interaction that records the calls ephemeralNotice makes, in order.
function fakeInteraction(ephemeral: boolean, deleteFails = false) {
  const calls: string[] = [];
  return {
    calls,
    ephemeral,
    async editReply(content: string) { calls.push(`edit:${content}`); },
    async deleteReply() {
      calls.push("delete");
      if (deleteFails) throw new Error("Unknown Message");
    },
    async followUp(options: { content: string; ephemeral: true }) {
      calls.push(`followUp:${options.content}:${options.ephemeral}`);
    },
  };
}

test("ephemeralNotice replaces a public placeholder instead of leaving it hanging", async () => {
  const interaction = fakeInteraction(false);
  await ephemeralNotice(interaction, "nope");
  expect(interaction.calls).toEqual(["delete", "followUp:nope:true"]);
});

test("ephemeralNotice edits an already-private defer", async () => {
  const interaction = fakeInteraction(true);
  await ephemeralNotice(interaction, "nope");
  expect(interaction.calls).toEqual(["edit:nope"]);
});

test("ephemeralNotice still answers when the placeholder cannot be deleted", async () => {
  const interaction = fakeInteraction(false, true);
  await ephemeralNotice(interaction, "nope");
  expect(interaction.calls).toEqual(["delete", "edit:nope"]);
});
