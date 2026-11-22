/**
 * Status ↔ progress rules. Pure functions, exhaustively tested in
 * tests/unit/status-rules.test.ts and documented in docs/product-decisions.md.
 *
 * Principles:
 * 1. Progress never silently forces "Completed". Reaching the end produces a
 *    *suggestion* the user confirms. Even with auto-apply enabled, completion
 *    is always a prompt.
 * 2. Dates are auto-filled only when empty, never overwritten.
 * 3. Re-opening a Completed item never erases history or date_completed unless
 *    the user explicitly confirms.
 */
import type { MediaType, Status } from '../shared/enums';
import type { StatusSuggestion } from '../shared/types';

export interface StatusState {
  type: MediaType;
  status: Status;
  dateStarted: string | null;
  dateCompleted: string | null;
  pass: number;
}

export interface ProgressFacts {
  isComplete: boolean;
  hasAnyProgress: boolean;
}

/** Suggestions after a progress update (entry added, episode watched, viewing logged). */
export function suggestionsAfterProgress(
  state: StatusState,
  before: ProgressFacts,
  after: ProgressFacts,
  today: string,
): StatusSuggestion[] {
  const out: StatusSuggestion[] = [];
  if (state.status === 'planned' && after.hasAnyProgress) {
    out.push({
      kind: 'start',
      status: 'in_progress',
      message: 'You logged progress on a Planned item. Move it to In Progress?',
      setDateStarted: state.dateStarted ?? today,
    });
  }
  if (after.isComplete && !before.isComplete && state.status !== 'completed') {
    out.push({
      kind: 'complete',
      status: 'completed',
      message: 'Looks like you reached the end. Mark it as Completed?',
      setDateStarted: null,
    });
  }
  // Progress regressed below complete (episode un-watched, percent lowered) on a Completed item.
  if (state.status === 'completed' && before.isComplete && !after.isComplete) {
    out.push({
      kind: 'reopen',
      status: 'in_progress',
      message: 'This item is marked Completed but is no longer fully tracked. Move it back to In Progress?',
      setDateStarted: null,
    });
  }
  return out;
}

/** Which suggestions the "auto-apply status suggestions" setting may apply without asking. */
export function isAutoApplicable(s: StatusSuggestion): boolean {
  // Completion is never applied automatically (principle 1).
  return s.kind === 'start' || s.kind === 'reopen';
}

export interface StatusChangeRequest {
  status: Status;
  startNewPass: boolean;
  clearDateCompleted: boolean;
}

export interface StatusChangePlan {
  status: Status;
  dateStarted: string | null;
  dateCompleted: string | null;
  pass: number;
  /** Confirmations the UI should ask for before (re)submitting with flags set. */
  confirmations: ('newPass' | 'clearDateCompleted')[];
  /** Whether "fill remaining progress" is meaningful for this transition. */
  offerFillRemaining: boolean;
  changed: boolean;
}

export function planStatusChange(
  state: StatusState,
  req: StatusChangeRequest,
  today: string,
): StatusChangePlan {
  const base: StatusChangePlan = {
    status: state.status,
    dateStarted: state.dateStarted,
    dateCompleted: state.dateCompleted,
    pass: state.pass,
    confirmations: [],
    offerFillRemaining: false,
    changed: false,
  };
  if (req.status === state.status) return base;

  const plan: StatusChangePlan = { ...base, status: req.status, changed: true };
  switch (req.status) {
    case 'completed':
      plan.dateCompleted = state.dateCompleted ?? today;
      plan.offerFillRemaining = true;
      break;
    case 'in_progress':
      plan.dateStarted = state.dateStarted ?? today;
      if (state.status === 'completed') {
        plan.confirmations = ['newPass', 'clearDateCompleted'];
        if (req.startNewPass) plan.pass = state.pass + 1;
        if (req.clearDateCompleted) plan.dateCompleted = null;
      }
      break;
    case 'planned':
    case 'on_hold':
    case 'dropped':
      // Progress and dates are preserved as-is.
      break;
  }
  return plan;
}

/** Statuses that count as "in progress" for the dashboard Continue widget. */
export function isActiveForContinue(status: Status): boolean {
  return status === 'in_progress';
}
