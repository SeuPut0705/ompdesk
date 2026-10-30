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

	it("says the wait is shared once two or more sessions wait on the provider together", () => {
		expect(modelWaitText(0, 4 * 60_000, t, 0)).toBe("chat.awaitingModel.wait|4m");
		expect(modelWaitText(0, 4 * 60_000, t, 1)).toBe("chat.awaitingModel.wait|4m");
		expect(modelWaitText(0, 4 * 60_000, t, 3)).toBe("chat.awaitingModel.together|4m");
		// Not before the wait itself is worth naming, however many others wait.
		expect(modelWaitText(0, 10_000, t, 3)).toBeNull();
	});
});
