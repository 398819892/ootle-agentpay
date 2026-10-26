"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EPOCH_MINUTES = void 0;
exports.formatEta = formatEta;
exports.windowStatus = windowStatus;
/** Approximate wall-clock length of one Ootle epoch. Used ONLY for the "≈" estimate below. */
exports.EPOCH_MINUTES = 30;
/** Format an approximate duration in minutes as an honest "≈…" string. */
function formatEta(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m <= 0)
        return "any moment";
    if (m < 60)
        return `≈${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `≈${h}h` : `≈${h}h ${rem}m`;
}
/**
 * Turn raw on-chain window state into friendly, honest numbers. Pure; never throws for ordinary
 * inputs (negative/zero values are clamped defensively).
 */
function windowStatus(info) {
    const dailyCap = Math.max(0, info.dailyCap);
    const epochsPerWindow = Math.max(1, info.epochsPerWindow);
    const resetEpoch = info.windowStartEpoch + epochsPerWindow;
    const windowElapsed = info.currentEpoch >= resetEpoch;
    // Once the window has elapsed the chain will zero the counter on the next payment (lazy reset),
    // so the amount effectively available now is the full cap, not `dailyCap - spentInWindow`.
    const spentInWindow = windowElapsed ? 0 : Math.max(0, info.spentInWindow);
    const remaining = Math.max(0, dailyCap - spentInWindow);
    const epochsUntilReset = windowElapsed ? 0 : Math.max(0, resetEpoch - info.currentEpoch);
    const approxMinutesUntilReset = epochsUntilReset * exports.EPOCH_MINUTES;
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
        epochMinutes: exports.EPOCH_MINUTES,
    };
}
