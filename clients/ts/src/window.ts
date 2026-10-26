/**
 * Rolling spend window — translating the AgentBudget "daily cap" into human-readable numbers.
 *
 * The on-chain template does NOT measure the daily cap against a calendar day. It measures it over
 * a rolling window of `epochs_per_window` chain epochs (an Ootle epoch is ≈30 min). The window
 * resets **lazily**: the spent counter is only zeroed on the next payment after the window has
 * elapsed (see `roll_window` in `templates/agent_budget/src/lib.rs`). That is correct but
 * unintuitive, so this module turns the raw `(daily_cap, spent_in_window, window_start_epoch,
 * epochs_per_window, current_epoch)` into "X left this window, resets in ≈Y".
 *
 * This is pure computation — no chain access, no mutation. The caller supplies the on-chain state
 * (read via `OnChainBudget.readWindow`, which queries walletd) and this returns friendly numbers.
 * The wall-clock figures are deliberately approximate ("≈"): epoch length is not fixed, so these
 * are estimates, not guarantees.
 */

/** Approximate wall-clock length of one Ootle epoch. Used ONLY for the "≈" estimate below. */
export const EPOCH_MINUTES = 30;

/** Raw on-chain window inputs (all amounts/epochs are plain integers). */
export interface BudgetWindowInput {
  /** The daily cap — the most that may be spent within one rolling window. */
  dailyCap: number;
  /** Amount spent so far in the current window (on chain; not yet lazily reset). */
  spentInWindow: number;
  /** Epoch at which the current window started. */
  windowStartEpoch: number;
  /** Window length in epochs (what the client passed to `open`). */
  epochsPerWindow: number;
  /** The current chain epoch (from `WalletdClient.currentEpoch`). */
  currentEpoch: number;
}

export interface WindowStatus {
  /** The configured daily cap (per rolling window, not per calendar day). */
  dailyCap: number;
  /** Spend that counts toward the cap *right now* — 0 once the window has elapsed. */
  spentInWindow: number;
  /** How much the agent may still spend before the window resets. */
  remaining: number;
  /** Window length in epochs. */
  epochsPerWindow: number;
  /** Epoch the current window started at. */
  windowStartEpoch: number;
  /** The current chain epoch. */
  currentEpoch: number;
  /** Epoch at which the window rolls over (`windowStartEpoch + epochsPerWindow`). */
  resetEpoch: number;
  /** Epochs remaining until reset (0 once elapsed). */
  epochsUntilReset: number;
  /**
   * True when the window has already elapsed on chain. Because the reset is lazy, the counter is
   * still non-zero on chain, but the next payment zeroes it first — so the full cap is effectively
   * available again now.
   */
  windowElapsed: boolean;
  /** Approximate minutes until reset (`epochsUntilReset * EPOCH_MINUTES`); 0 once elapsed. */
  approxMinutesUntilReset: number;
  /** Human-readable, honest ETA: "≈2h 30m", "≈45 min", or "any moment". */
  resetEta: string;
  /** The epoch-length assumption behind the estimate, so callers can show it. */
  epochMinutes: number;
}

/** Format an approximate duration in minutes as an honest "≈…" string. */
export function formatEta(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m <= 0) return "any moment";
  if (m < 60) return `≈${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `≈${h}h` : `≈${h}h ${rem}m`;
}

/**
 * Turn raw on-chain window state into friendly, honest numbers. Pure; never throws for ordinary
 * inputs (negative/zero values are clamped defensively).
 */
export function windowStatus(info: BudgetWindowInput): WindowStatus {
  const dailyCap = Math.max(0, info.dailyCap);
  const epochsPerWindow = Math.max(1, info.epochsPerWindow);
  const resetEpoch = info.windowStartEpoch + epochsPerWindow;
  const windowElapsed = info.currentEpoch >= resetEpoch;

  // Once the window has elapsed the chain will zero the counter on the next payment (lazy reset),
  // so the amount effectively available now is the full cap, not `dailyCap - spentInWindow`.
  const spentInWindow = windowElapsed ? 0 : Math.max(0, info.spentInWindow);
  const remaining = Math.max(0, dailyCap - spentInWindow);
  const epochsUntilReset = windowElapsed ? 0 : Math.max(0, resetEpoch - info.currentEpoch);
  const approxMinutesUntilReset = epochsUntilReset * EPOCH_MINUTES;

  return {
    dailyCap,
    spentInWindow,
    remaining,
    epochsPerWindow,
    windowStartEpoch: info.windowStartEpoch,
    currentEpoch: info.currentEpoch,
    resetEpoch,
    epochsUntilReset,
    windowElapsed,
    approxMinutesUntilReset,
    resetEta: windowElapsed ? "any moment" : formatEta(approxMinutesUntilReset),
    epochMinutes: EPOCH_MINUTES,
  };
}
