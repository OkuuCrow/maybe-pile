/**
 * View types for 2.1 channels. Dependency-free (renderer-safe); the main
 * services return structurally identical objects.
 */
import type { MediaType, StatusSuggestionKind } from './views-21-enums';
import type { ItemSummary, StatusSuggestion } from './types';
import type { LibraryQuery, BackdropStyle } from './schemas';
import type { ItemTemplateBody } from './pack21-schemas';

export interface FileOpView {
  fileLabel: string;
  bytes: number;
}

export interface QuickResultView {
  item: ItemSummary;
  undoToken: string;
  message: string;
  suggestion: StatusSuggestion | null;
}

export interface TrashEntryView {
  id: string;
  title: string;
  type: string;
  deletedAt: string;
  purgeOn: string;
}

export interface ChangeView {
  id: number;
  batchId: string;
  itemId: string;
  itemTitle: string;
  at: string;
  source: 'user' | 'bulk' | 'rule' | 'triage' | 'restore' | 'trash';
  field: string;
  fieldLabel: string;
  oldValue: string | null;
  newValue: string | null;
  undone: boolean;
  undoable: boolean;
  whyNotUndoable: string | null;
}

export interface ChecklistView {
  itemId: string;
  entries: { id: string; text: string; position: number; checked: boolean; checkedAt: string | null }[];
  done: number;
  total: number;
  complete: boolean;
}

export interface LoanView {
  id: string;
  itemId: string;
  itemTitle: string;
  personId: string | null;
  person: string;
  direction: 'lent' | 'borrowed';
  loanedOn: string;
  dueOn: string | null;
  returnedOn: string | null;
  note: string | null;
  overdue: boolean;
}

export interface PersonView {
  id: string;
  name: string;
  forgotten: boolean;
  loans: number;
  recommended: number;
  recommendedInPile: number;
  recommendedCompleted: number;
}

export interface JournalEntryView {
  id: string;
  itemId: string;
  entryDate: string;
  body: string;
  progressLabel: string | null;
  spoiler: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ItemExtrasView {
  nextStep: { text: string; spoiler: boolean } | null;
  checklist: ChecklistView;
  loans: LoanView[];
  recommender: { person: string; personId: string; note: string | null; recommendedOn: string | null } | null;
  journalCount: number;
}

export interface SavedViewView {
  id: string;
  name: string;
  query: LibraryQuery;
  viewMode: 'grid' | 'list' | 'wall';
  position: number;
  pinned: boolean;
  notices: string[];
}

export interface StarterView {
  name: string;
  query: Partial<LibraryQuery>;
  viewMode: 'grid' | 'list';
}

export interface TemplateView {
  id: string;
  name: string;
  body: ItemTemplateBody;
  position: number;
}

export interface StarterTemplate {
  name: string;
  body: ItemTemplateBody;
}

export interface TimeGoalView {
  id: string;
  title: string;
  targetMinutes: number;
  period: 'day' | 'week';
  mediaType: MediaType | null;
  listId: string | null;
  moodId: string | null;
  archived: boolean;
  minutes: number;
  pace: 'done' | 'ahead' | 'on-track' | 'a-bit-behind';
  paceLabel: string;
  history: { label: string; minutes: number }[];
}

export interface MatchCandidateView {
  title: string;
  year: number | null;
  type: MediaType;
  creators: string[];
  thumbUrl: string | null;
  providerId: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface MatchedLineView {
  lineId: number;
  raw: string;
  title: string;
  year: number | null;
  type: MediaType | null;
  duplicateOf: { id: string; title: string } | null;
  repeatOfLine: number | null;
  status: 'matched' | 'no-match' | 'no-source' | 'error' | 'pending';
  candidates: MatchCandidateView[];
  error: string | null;
}

export interface PasteParseView {
  token: string;
  lines: MatchedLineView[];
  sourceAvailable: Record<MediaType, boolean>;
}

export interface QueueEntryView {
  id: string;
  itemId: string;
  title: string;
  type: MediaType;
  state: string;
  attempts: number;
  lastError: string | null;
  candidates: MatchCandidateView[];
}

export interface FindingView {
  code: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  explanation: string;
  count: number;
  fix: { id: string; label: string; safe: boolean; preview: string } | null;
}

export interface CheckupReportView {
  ranAt: string;
  findings: FindingView[];
  ok: boolean;
}

export interface BulkPreviewView {
  total: number;
  changes: { field: string; label: string; count: number }[];
  exceptions: { itemId: string; title: string; reason: string }[];
  unchanged: number;
}

export interface RulePreviewView {
  rule: 'suggestCompleted' | 'onHoldAfterDays' | 'stalePlanned' | 'removeFromUpNextOnStart';
  label: string;
  items: { id: string; title: string }[];
}

export interface RulesRunView {
  batchId: string | null;
  changed: number;
  suggestions: { id: string; title: string; suggestion: StatusSuggestion }[];
}

export type TriageUndoView =
  | { kind: 'none'; itemId: string }
  | { kind: 'upNext'; itemId: string }
  | { kind: 'snooze'; itemId: string; prevUntil: string | null }
  | { kind: 'batch'; itemId: string; batchId: string };

export interface BackupDirCheckView {
  exists: boolean;
  sameVolume: boolean;
  cloudHint: string | null;
  removableHint: boolean;
  warnings: string[];
}

export interface PaletteView {
  colors: string[];
  darkest: string;
  brightest: string;
  luminance: number;
}

export interface ItemBackdropView {
  itemStyle: 'default' | BackdropStyle;
  palette: PaletteView | null;
  backgroundUrl: string | null;
  coverThumbUrl: string | null;
  adult: boolean;
}

export interface StorageView {
  cacheBytes: number;
  cacheFiles: number;
  userBytes: number;
  evictableBytes: number;
  capMb: number;
}

export interface LibraryView {
  id: string;
  name: string;
  active: boolean;
  isDefault: boolean;
  createdAt: string;
}

export type { StatusSuggestionKind };
