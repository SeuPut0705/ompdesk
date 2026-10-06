/**
 * Wire-robustness contracts for values the sidecar can legitimately send but
 * the renderer's typed unions do not cover.
 *
 * Two failure classes are pinned here, both observed as full white screens:
 *
 * 1. Status/role lookup tables indexed by a free-form wire string. A missing
 *    key yields `undefined`, and the very next property read (`.live`,
 *    `.variant`, `.dot`) throws, tearing down the React tree.
 * 2. Numeric aggregates that reach the renderer as `null` (JSON.stringify
 *    turns NaN/Infinity into null) or as a missing key. `x !== null` does NOT
 *    catch `undefined`, so a raw `.toFixed()` behind that guard still throws.
 */

import { describe, expect, it } from "vitest";
import { isLiveSubagentStatus, statusMeta } from "../components/panels/subagent-graph";
import { formatCost, formatPercent } from "./format";

/** Statuses the agent actually emits, beyond the four the wire type declares. */
const UNDECLARED_WIRE_STATUSES = ["running", "pending", "aborted", "parked", "idle", "future_state", ""];

describe("subagent status lookups", () => {
	it("returns usable metadata for every undeclared wire status", () => {
		for (const status of UNDECLARED_WIRE_STATUSES) {
			const meta = statusMeta(status);
			// The crash was `undefined.live`; every field must be readable.
			expect(typeof meta.live).toBe("boolean");
			expect(typeof meta.variant).toBe("string");
			expect(typeof meta.labelKey).toBe("string");
		}
	});

	it("treats in-flight statuses as live and settled ones as not", () => {
		for (const status of ["started", "running", "pending", "idle", "parked"]) {
			expect(isLiveSubagentStatus(status)).toBe(true);
		}
		for (const status of ["completed", "failed", "cancelled", "aborted"]) {
			expect(isLiveSubagentStatus(status)).toBe(false);
		}
	});

	it("keeps the live flag consistent between the predicate and the metadata", () => {
		// The frozen-timer bug came from a tick gate disagreeing with the row's
		// own display gate; both read this pair, so they must not diverge.
		for (const status of [...UNDECLARED_WIRE_STATUSES, "started", "completed", "failed", "cancelled"]) {
			expect(statusMeta(status).live).toBe(isLiveSubagentStatus(status));
		}
	});
});

describe("numeric wire formatting", () => {
	it("renders a placeholder instead of throwing on null, undefined, and NaN cost", () => {
		for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(formatCost(value)).toBe("—");
		}
	});

	it("formats real costs with the requested precision", () => {
		expect(formatCost(0)).toBe("$0.0000");
		expect(formatCost(1.23456789, 6)).toBe("$1.234568");
	});

	it("renders a placeholder instead of throwing on null, undefined, and NaN percent", () => {
		for (const value of [null, undefined, Number.NaN]) {
			expect(formatPercent(value, 1)).toBe("—");
		}
	});

	it("formats real percents with the requested precision", () => {
		expect(formatPercent(42.36, 1)).toBe("42.4%");
		expect(formatPercent(99.9, 0)).toBe("100%");
	});
});
