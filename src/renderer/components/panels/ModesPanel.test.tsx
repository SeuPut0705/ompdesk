/**
 * Tests for the modes window: closed-state rendering plus the pure
 * status-variant, loop-limit, and loop-event normalization contracts that
 * drive the Vibe/Goal/Loop tabs. (Open-state SSR assertions are not viable:
 * react-dom/server renders createPortal children as empty in this repo's
 * test environment.)
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { normalizeLoopUpdate, parseLoopLimit } from "../../lib/loop-mode";
import { goalStatusVariant, LOOP_STATE_VARIANT, ModesPanel } from "./ModesPanel";

describe("ModesPanel closed state", () => {
	it("renders nothing while closed", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModesPanel onClose={() => {}} open={false} />
			</I18nProvider>,
		);
		expect(html).toBe("");
	});

	it("accepts an initialTab deep-link while closed", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModesPanel initialTab="goal" onClose={() => {}} open={false} />
			</I18nProvider>,
		);
		expect(html).toBe("");
	});
});

describe("goalStatusVariant", () => {
	it("maps known goal statuses to badge variants", () => {
		expect(goalStatusVariant("active")).toBe("success");
		expect(goalStatusVariant("paused")).toBe("warning");
		expect(goalStatusVariant("budget-limited")).toBe("error");
		expect(goalStatusVariant("complete")).toBe("info");
		expect(goalStatusVariant("dropped")).toBe("muted");
	});

	it("falls back to muted for unknown statuses", () => {
		expect(goalStatusVariant("whatever-next")).toBe("muted");
	});
});

describe("LOOP_STATE_VARIANT", () => {
	it("covers every loop run-state", () => {
		expect(LOOP_STATE_VARIANT).toEqual({ off: "muted", waiting: "info", running: "success", paused: "warning" });
	});
});

describe("parseLoopLimit", () => {
	it("treats a positive number as an iteration count (declared GUI shape)", () => {
		expect(parseLoopLimit(10)).toEqual({ kind: "count", count: 10 });
	});

	it("parses the sidecar's iterations runtime object", () => {
		expect(parseLoopLimit({ kind: "iterations", initial: 10, remaining: 4 })).toEqual({
			kind: "iterations",
			initial: 10,
			remaining: 4,
		});
	});

	it("parses the sidecar's duration runtime object", () => {
		expect(parseLoopLimit({ kind: "duration", durationMs: 600_000, deadlineMs: 123 })).toEqual({
			kind: "duration",
			durationMs: 600_000,
			deadlineMs: 123,
		});
	});

	it("rejects missing, non-positive, and malformed limits", () => {
		expect(parseLoopLimit(undefined)).toBeNull();
		expect(parseLoopLimit(null)).toBeNull();
		expect(parseLoopLimit(0)).toBeNull();
		expect(parseLoopLimit(Number.NaN)).toBeNull();
		expect(parseLoopLimit("10")).toBeNull();
		expect(parseLoopLimit({ kind: "iterations", initial: "10" })).toBeNull();
		expect(parseLoopLimit({ kind: "other" })).toBeNull();
	});
});

describe("normalizeLoopUpdate", () => {
	it("accepts the flat frame declared by the GUI contract", () => {
		const event = {
			type: "loop_mode_update",
			enabled: true,
			state: "running",
			prompt: "keep going",
			limit: 5,
		} as unknown as AgentSessionEvent & { type: "loop_mode_update" };
		expect(normalizeLoopUpdate(event)).toEqual({
			enabled: true,
			state: "running",
			prompt: "keep going",
			limit: { kind: "iterations", initial: 5, remaining: 5 },
		});
	});

	it("accepts the nested frame the sidecar actually emits", () => {
		const nested = {
			type: "loop_mode_update",
			state: { enabled: true, state: "waiting", prompt: "poll the queue" },
		} as unknown as AgentSessionEvent & { type: "loop_mode_update" };
		expect(normalizeLoopUpdate(nested)).toEqual({
			enabled: true,
			state: "waiting",
			prompt: "poll the queue",
			limit: undefined,
		});
	});

	it("rejects frames without a usable enabled/state pair", () => {
		const missing = { type: "loop_mode_update" } as unknown as AgentSessionEvent & { type: "loop_mode_update" };
		expect(normalizeLoopUpdate(missing)).toBeNull();
		const badNested = {
			type: "loop_mode_update",
			state: { enabled: "yes" },
		} as unknown as AgentSessionEvent & { type: "loop_mode_update" };
		expect(normalizeLoopUpdate(badNested)).toBeNull();
	});
});
