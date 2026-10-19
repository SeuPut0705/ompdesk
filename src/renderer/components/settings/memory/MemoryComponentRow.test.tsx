import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAiMemoryStore } from "../../../stores/ai-memory";
import { MemoryComponentRow } from "./MemoryComponentRow";
import { cleanup, fakeMemoryApi, installApi, memoryState, mount, text } from "./memory-test-harness";

beforeEach(() => installApi(fakeMemoryApi()));
afterEach(cleanup);

describe("Memory as an OMPdesk component", () => {
	it("shows version, status and that it updates with OMPdesk, with no link", async () => {
		useAiMemoryStore.setState({ state: memoryState() });
		await mount(<MemoryComponentRow />);
		const row = text("#setting-memory-component");
		expect(row).toContain("Memory");
		expect(row).toContain("v3.1.1");
		expect(row).toContain("Running");
		expect(row).toContain("updated with OMPdesk");
		expect(document.body.querySelector("a")).toBeNull();
		expect(row.toLowerCase()).not.toContain("ai-memory");
	});
});
