// Votes needed to force-skip the current song: a simple majority of the users
// currently present in the room, with a floor of 1 so a lone listener can skip.
export function skipThreshold(presentCount: number): number {
  return Math.max(1, Math.ceil(presentCount / 2));
}
