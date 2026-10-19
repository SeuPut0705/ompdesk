import { describe, expect, it } from "vitest";
import { moveDevice, orderDevices } from "./device-order";

describe("orderDevices", () => {
	it("puts the saved order first and the devices it does not name after, in the default order", () => {
		expect(orderDevices(["local", "dev-a", "dev-b", "dev-c"], ["dev-b", "local"])).toEqual([
			"dev-b",
			"local",
			"dev-a",
			"dev-c",
		]);
	});

	it("ignores saved ids that are not present and repeated ones", () => {
		expect(orderDevices(["local", "dev-a"], ["dev-gone", "dev-a", "dev-a"])).toEqual(["dev-a", "local"]);
	});

	it("is the default order when nothing was saved", () => {
		expect(orderDevices(["local", "dev-a"], [])).toEqual(["local", "dev-a"]);
	});
});

describe("moveDevice", () => {
	it("moves one place up or down", () => {
		expect(moveDevice(["local", "dev-a", "dev-b"], "dev-b", -1)).toEqual(["local", "dev-b", "dev-a"]);
		expect(moveDevice(["local", "dev-a", "dev-b"], "local", 1)).toEqual(["dev-a", "local", "dev-b"]);
	});

	it("leaves the order alone at an edge or for an unknown device", () => {
		expect(moveDevice(["local", "dev-a"], "local", -1)).toEqual(["local", "dev-a"]);
		expect(moveDevice(["local", "dev-a"], "dev-a", 1)).toEqual(["local", "dev-a"]);
		expect(moveDevice(["local", "dev-a"], "dev-x", 1)).toEqual(["local", "dev-a"]);
	});
});
