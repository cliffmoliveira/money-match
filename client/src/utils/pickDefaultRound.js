// Given the full round-pill list for a game — [Outright, ...history rounds
// (earliest→latest), Top 8] — pick which pill to open by default:
//   1. the live round, if any part of the bracket is in progress right now
//      (the latest one, so Top 8 beats an earlier round both reading 'live');
//   2. otherwise the most recently completed round (the latest 'done');
//   3. otherwise the first pill (Outright) — a tournament that hasn't started,
//      so there's nothing played yet to land on.
// So an in-flight tournament opens on the action instead of always dumping the
// user on the Outright/Top-8 default regardless of where the bracket actually is.
export function pickDefaultRoundText(pills) {
  const reversed = [...pills].reverse();
  const live = reversed.find((p) => p.status === 'live');
  if (live) return live.roundText;
  const done = reversed.find((p) => p.status === 'done');
  if (done) return done.roundText;
  return pills[0]?.roundText ?? 'Outright';
}
