/**
 * Franchise ordering and "Next in series".
 *
 * A franchise is an ordered list of items (position) with a mainline flag.
 * Next in series = the first mainline entry after the furthest completed
 * mainline entry that is not completed/dropped. If `respectOrder` is off, the
 * first unfinished mainline entry is returned. Side entries are never "next".
 */
export interface FranchiseEntry {
  itemId: string;
  position: number;
  mainline: boolean;
  status: string;
}

export function nextInSeries(entries: FranchiseEntry[], respectOrder: boolean): string | null {
  const main = entries.filter((e) => e.mainline).sort((a, b) => a.position - b.position);
  if (main.length === 0) return null;
  const done = (s: string) => s === 'completed' || s === 'dropped';
  if (!respectOrder) return main.find((e) => !done(e.status))?.itemId ?? null;
  let lastDone = -1;
  main.forEach((e, i) => {
    if (e.status === 'completed') lastDone = i;
  });
  // In-progress mainline entries before the furthest completed one still come first.
  const inProgress = main.find((e) => e.status === 'in_progress');
  if (inProgress) return inProgress.itemId;
  return main.slice(lastDone + 1).find((e) => !done(e.status))?.itemId ?? null;
}

/** Positions after inserting at `index` (keeps gaps so reorders stay cheap). */
export function reorderPositions(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, (i + 1) * 10]));
}
