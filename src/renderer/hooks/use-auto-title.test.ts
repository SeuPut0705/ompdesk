import { describe, expect, it } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { regenerationOutcome } from "./use-auto-title";

const reply = (data: unknown): RpcResponse => ({
	type: "response",
	command: "regenerate_session_title",
	success: true,
	data,
});

describe("regenerationOutcome", () => {
	it("returns the saved title", () => {
		expect(regenerationOutcome(reply({ title: "Fix login bug" }))).toEqual({ title: "Fix login bug" });
	});

	it("words why there is no title", () => {
		expect(regenerationOutcome(reply({ title: null, reason: "none" }))).toEqual({
			failure: translate("titleAuto.none"),
		});
		expect(regenerationOutcome(reply({ title: null, reason: "superseded" }))).toEqual({
			failure: translate("titleAuto.superseded"),
		});
		// An answer that is neither shape is a failure, not a blank title.
		expect(regenerationOutcome(reply({ title: "" }))).toEqual({ failure: translate("titleAuto.none") });
		expect(regenerationOutcome(reply(undefined))).toEqual({ failure: translate("titleAuto.none") });
	});

	it("words a failed command: a coded failure with its own sentence, anything else generically", () => {
		expect(
			regenerationOutcome({
				type: "response",
				command: "regenerate_session_title",
				success: false,
				error: "title model unavailable",
			}),
		).toEqual({ failure: translate("titleAuto.failed") });
		expect(
			regenerationOutcome({
				type: "response",
				command: "regenerate_session_title",
				success: false,
				error: "unsupported_omp",
				code: "unsupported_omp",
			}),
		).toEqual({ failure: translate("ipcError.unsupported_omp") });
	});
});
