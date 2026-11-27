/** Toast "Undo" action for a Recent-changes batch (bulk edit, rules, triage). */
import { call, getApi } from './api';

export function batchAction(
  batchId: string | null,
  after: () => void,
): { label: string; run: () => void } | undefined {
  if (!batchId) return undefined;
  return { label: 'Undo', run: () => void call(getApi().changes.undoBatch({ batchId })).then(after) };
}
