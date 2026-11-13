/**
 * The archive's client against a core that answers out of order: calls run in the core in the order they were made,
 * but their answers may arrive in any order (ci run 43432214532 saw the first call's answer land after the second's
 * and the served roots lose the replaced build). The real core cannot be made to do it on cue, so this one is held.
 */
import { describe, expect, it, vi } from "vitest";

const held: Array<(roots: string[]) => void> = [];

vi.mock("../core/process", () => ({
	core: () => ({
		call: () => new Promise(resolve => held.push(roots => resolve({ result: { roots } }))),
	}),
}));

import { AssetArchive } from "./asset-archive";

describe("AssetArchive answers out of order", () => {
	it("serves what the last call made left, whichever answer arrives last", async () => {
		const archive = new AssetArchive({ userData: "/unused" });
		const first = archive.retain("/first");
		const second = archive.retain("/second");
		expect(held).toHaveLength(2);
		// The second call's answer first, the first call's after it.
		held[1]?.(["/replaced-a"]);
		await second;
		held[0]?.([]);
		await first;
		expect(archive.roots()).toEqual(["/replaced-a"]);
	});
});
