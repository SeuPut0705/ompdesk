import { describe, expect, it } from "vitest";
import { MODEL_WAIT_SHOWN_MS, modelWaitText } from "./model-wait";

const t = (key: string, params?: Record<string, string | number>) => `${key}|${params?.time ?? ""}`;

describe("modelWaitText", () => {
	it("says nothing while no request waits, or before the wait is worth naming", () => {
		expect(modelWaitText(null, 1_000_000, t)).toBeNull();
		expect(modelWaitText(1_000_000, 1_000_000 + MODEL_WAIT_SHOWN_MS - 1, t)).toBeNull();
	});

	it("names the model's wait and how long it has lasted once the request went that long unanswered", () => {
		expect(MODEL_WAIT_SHOWN_MS).toBe(30_000);
		expect(modelWaitText(0, 30_000, t)).toBe("chat.awaitingModel.wait|30s");
		expect(modelWaitText(0, 2 * 60_000 + 40_000, t)).toBe("chat.awaitingModel.wait|2m");
	});
});
