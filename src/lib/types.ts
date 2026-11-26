export interface DailyRow {
  date: string;
  cost: number;
  requests: number;
  inputFresh: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  inputTotal: number;
  engagedMs: number;
  engagedHours: number;
  prompts: number;
  avgContext: number;
  cacheHit: number;
  costFresh: number;
  costCacheWrite: number;
  costCacheRead: number;
  costOutput: number;
}

export interface SessionRow {
  id: string | null;
  title: string | null;
  branch: string | null;
  start: string | null;
  end: string | null;
  cost: number;
  rawCost: number;
  ledgerCost: number | null;
  requests: number;
  inputTotal: number;
  cacheRead: number;
  output: number;
  toolCalls: number;
  engagedMs: number;
  durationMs: number;
  cacheHit: number;
  topModel: string | null;
  models: Record<string, number>;
}

export interface Insight {
  level: 'good' | 'warn' | 'bad' | 'info';
  title: string;
  detail: string;
}

export interface Report {
  root: string;
  home: string;
  generatedAt: string;
  scanMs: number;
  warnings: string[];
  sources: {
    transcriptDirs: number;
    transcriptFiles: number;
    filesParsed: number;
    filesFromCache: number;
    ledgerFiles: string[];
    historyRows: number;
  };
  coverage: {
    transcriptFirst: string | null;
    transcriptLast: string | null;
    historyFirst: string | null;
    historyLast: string | null;
    sessionsInLedger: number;
    sessionsWithTranscripts: number;
    sessionsMatched: number;
    costDatedUsd: number;
    costUndatedUsd: number;
    costCoverage: number;
  };
  totals: {
    cost: number;
    rawCost: number;
    ledgerCost: number;
    requests: number;
    inputFresh: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheRead: number;
    output: number;
    totalInput: number;
    engagedMs: number;
    toolCalls: number;
    webSearches: number;
    sidechainRequests: number;
    sidechainCost: number;
    cacheSavings: number;
    costFresh: number;
    costCacheWrite: number;
    costCacheRead: number;
    costOutput: number;
    sessions: number;
    activeDays: number;
    promptsAllTime: number;
  };
  daily: DailyRow[];
  /** Per-day, per-model series; `rows` is dollars. */
  dailyByModel: {
    models: string[];
    rows: Record<string, number | string>[];
    tokens: Record<string, number | string>[];
    engagedHours: Record<string, number | string>[];
  };
  /** Same shape as `dailyByModel`, keyed by project path, costliest first. */
  dailyByProject: {
    projects: string[];
    rows: Record<string, number | string>[];
    tokens: Record<string, number | string>[];
    engagedHours: Record<string, number | string>[];
  };
  /** Lines changed by successful Edit/Write calls, per day x model x file category x project. */
  edits: {
    categories: { key: string; label: string }[];
    rows: {
      date: string;
      model: string;
      category: string;
      project: string;
      added: number;
      removed: number;
      edits: number;
    }[];
    extensions: { ext: string; category: string; added: number; removed: number; edits: number }[];
  };
  projects: ProjectEntry[];
  /** Sessions counted from archived digests (transcript since deleted). */
  archive: { sessions: number; sessionsTotal: number };
  costTimeline: { date: string; exact: number; estimated: number; prompts: number; cumulative: number }[];
  punchcard: { dow: number; hour: number; prompts: number }[];
  models: { model: string; cost: number; requests: number; output: number; inputTotal: number; share: number }[];
  branches: { branch: string; cost: number; requests: number }[];
  tools: { name: string; count: number }[];
  effort: { effort: string; cost: number; requests: number }[];
  sessions: SessionRow[];
  sessionCostHistogram: { from: number; to: number; count: number; cost: number }[];
  efficiency: Record<string, number>;
  reconciliation: {
    matchedSessions: number;
    unmatchedTranscripts: number;
    ledgerCostMatched: number;
    rawCostMatched: number;
    rescaledSessions: number;
    rawVsLedgerPct: number;
  };
  insights: Insight[];
}

/** A project under the scanned root: a folder with its own cost ledger. */
export interface ProjectEntry {
  path: string;
  cost: number;
  sessions: number;
  prompts: number;
  transcripts: number;
  lastSeen: number;
  hidden: boolean;
}

export interface RootEntry {
  path: string;
  cost: number;
  sessions: number;
  prompts: number;
  lastSeen: number;
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  hasClaudeData: boolean;
  hasLedger: boolean;
  dirs: { name: string; path: string; hasClaudeData: boolean; hasLedger: boolean }[];
}
