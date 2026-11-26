// Model pricing, USD per 1M tokens. Source: Anthropic public list prices
// (checked 2026-11-26).
//
// A row is [input, output] or [input, output, cacheReadMult]. Cache writes are
// uniform across the API (1.25x input for the 5-minute TTL, 2x for 1-hour);
// cache reads are 0.1x input except on the newest models, which discount them
// further, so those rows carry their own multiplier.

export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2.0;
const DEFAULT_CACHE_READ_MULT = 0.1;

const PRICES = {
  // Fable / Mythos tier. 5.1 and later read cache at 0.025x.
  'claude-fable-5-2': [8, 40, 0.025],
  'claude-mythos-5-2': [8, 40, 0.025],
  'claude-fable-5-1': [10, 50, 0.025],
  'claude-mythos-5-1': [10, 50, 0.025],
  'claude-fable-5': [10, 50],
  'claude-mythos-5': [10, 50],
  'claude-mythos-preview': [10, 50],
  // Opus 4.5 → 5.5
  'claude-opus-5-5': [4, 20, 0.05],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-5': [5, 25],
  // Older Opus kept the $15/$75 tier
  'claude-opus-4-1': [15, 75],
  'claude-opus-4-0': [15, 75],
  'claude-opus-4': [15, 75],
  'claude-3-opus': [15, 75],
  // Sonnet
  'claude-sonnet-5-5': [2, 10, 0.05],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-sonnet-4-0': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-3-7-sonnet': [3, 15],
  'claude-3-5-sonnet': [3, 15],
  // Haiku
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
  'claude-3-5-haiku': [0.8, 4],
  'claude-3-haiku': [0.25, 1.25],
};

// Fast mode runs the same model at premium rates (Claude API).
const FAST_PRICES = {
  'claude-fable-5-2': [16, 80, 0.025],
  'claude-mythos-5-2': [16, 80, 0.025],
  'claude-opus-5-5': [8, 40, 0.05],
  'claude-opus-5': [10, 50],
  'claude-opus-4-8': [10, 50],
};

// Haiku 5.5 switches to a second rate card when the whole prompt (fresh +
// cached input) is over 100K tokens.
const LONG_PROMPT = {
  'claude-haiku-5-5': { over: 100_000, rate: [0.5, 2.5] },
};

// Claude Code writes placeholder assistant records (API errors, local command
// output) under this pseudo-model. They carry no billable usage.
const NON_BILLABLE = new Set(['<synthetic>', 'unknown']);

const unknownModels = new Set();

/**
 * Transcripts record model ids with and without date suffixes
 * (`claude-haiku-4-5-20251001`). Match the longest known prefix — so
 * `claude-opus-5-5` must have its own row, or it silently bills as Opus 5.
 */
function lookup(table, model) {
  if (!model) return null;
  if (table[model]) return table[model];
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = table[key];
      bestLen = key.length;
    }
  }
  return best;
}

/** The rate card one request bills at: { inRate, outRate, readMult } or null. */
function rateFor(u) {
  if (NON_BILLABLE.has(u.model)) return null;
  let row = (u.speed === 'fast' && lookup(FAST_PRICES, u.model)) || lookup(PRICES, u.model);
  if (!row) {
    unknownModels.add(u.model);
    return null;
  }
  const long = lookup(LONG_PROMPT, u.model);
  if (long && u.speed !== 'fast') {
    const prompt = u.inputTokens + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
    if (prompt > long.over) row = long.rate;
  }
  const [inRate, outRate, readMult = DEFAULT_CACHE_READ_MULT] = row;
  return { inRate, outRate, readMult };
}

/**
 * Cost of one request in USD. `u` is a normalised usage row.
 * Returns 0 for models we have no price for — those are surfaced separately
 * via `unpricedModels()` rather than silently guessed at.
 */
export function costOf(u) {
  const p = costParts(u);
  return p.input + p.cacheWrite + p.cacheRead + p.output;
}

/**
 * Same total as costOf, split by what the tokens were. Cache reads are ~98% of
 * tokens but a much smaller slice of the bill, so the split is the only honest
 * way to chart "where the money went" within a day.
 */
export function costParts(u) {
  const rate = rateFor(u);
  if (!rate) return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const { inRate, outRate, readMult } = rate;
  return {
    input: (u.inputTokens * inRate) / 1e6,
    cacheWrite:
      (u.cacheWrite5m * inRate * CACHE_WRITE_5M_MULT + u.cacheWrite1h * inRate * CACHE_WRITE_1H_MULT) / 1e6,
    cacheRead: (u.cacheRead * inRate * readMult) / 1e6,
    output: (u.outputTokens * outRate) / 1e6,
  };
}

export function isPriced(model) {
  return NON_BILLABLE.has(model) || lookup(PRICES, model) !== null;
}

export function unpricedModels() {
  return [...unknownModels];
}
