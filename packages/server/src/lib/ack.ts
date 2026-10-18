// Slash-command acknowledgment policy. Discord gives an interaction three
// seconds to answer; anything slower (a SQLite write waiting on the busy
// timeout, a yt-dlp round trip, a large playlist insert) makes Discord expire
// it, and the late reply then fails with 10062 "Unknown interaction" — the
// command is simply lost. So every command is deferred before the first
// awaited work, which means its ephemeral/public style has to be decided here
// instead of per branch, and every branch answers through editReply.
//
// Pure and Discord-free so the "every registered command is classified" rule
// is testable: a command added later without an entry here is reported at boot
// and fails the test suite.

export const EPHEMERAL_REPLIES: Readonly<Record<string, boolean>> = {
  play: false,
  search: true,
  listen: false,
  stop: false,
  skip: true,
  // The queue panel is intentionally shared: everyone in the channel votes and
  // removes from it.
  queue: false,
  lyrics: true,
  reset: false,
  room: false,
  admin: true,
  help: true,
};

// Unknown commands stay public: a missing entry must fail loudly at boot, and
// silently hiding a brand-new command's answer would be worse than showing it.
export function replyIsEphemeral(commandName: string): boolean {
  return EPHEMERAL_REPLIES[commandName] ?? false;
}

export function unclassifiedCommands(names: readonly string[]): string[] {
  return names.filter((name) => !Object.hasOwn(EPHEMERAL_REPLIES, name));
}
