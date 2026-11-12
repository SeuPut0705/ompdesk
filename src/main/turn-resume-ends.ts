/**
 * When a tab's held work ends: its connection wait, its reachability probe, its scheduled retry, and a continuation on
 * its way. One table: each row is something that ends a hold, each column a place the resume looks at a hold. The core
 * asks the table at every one of those places (`native/ompdesk/crates/core/src/resume/ends.rs`) and decides there only
 * what the end does (which rows and timers go). The model mirrors it name for name
 * (`formal/turn-resume/tla/TurnResume.tla`): row `x` is `End_x`, check `y` is `Ends_y`, built from exactly the rows listed
 * for it; `turn-resume-ends.test.ts` fails on any difference. A row the model keeps constant (a closed tab, the quit, a
 * first file) is on that test's fixed list.
 *
 * The names and the places each row applies at are the data file `hold-ends.json` beside the core's code, the one copy
 * both languages read; what a row means is the core's `applies`, and its Rust test fails on a row the table names and
 * the rule does not know.
 */
import table from "../../native/ompdesk/crates/core/src/resume/hold-ends.json";

/** Where the resume looks at a hold, with the model action that looks. */
export const HOLD_CHECKS = table.checks;

export type HoldCheck = keyof typeof HOLD_CHECKS;

/**
 * Every end condition. The order is the precedence the core reports, and only `continuing` acts on which one it was: a
 * move ends every hold of the tab, the person's prompt only that continuation.
 */
export const HOLD_ENDS = table.ends;

export type HoldEnd = keyof typeof HOLD_ENDS;
