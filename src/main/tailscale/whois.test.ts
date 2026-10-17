import { describe, expect, it } from "vitest";
import { parseWhois } from "./whois";

describe("parseWhois", () => {
	it("reads the node's stable ID, its device name and the owner's login", () => {
		const stdout = JSON.stringify({
			Node: {
				StableID: "nABC123CNTRL",
				Name: "seuput-s25u.tail1234.ts.net.",
				ComputedName: "SeuPut S25U",
				Hostinfo: { Hostname: "SM-S938B", OS: "android" },
			},
			UserProfile: { LoginName: "seuput@example.com", DisplayName: "SeuPut" },
		});
		expect(parseWhois(stdout)).toEqual({
			nodeId: "nABC123CNTRL",
			nodeName: "SeuPut S25U",
			login: "seuput@example.com",
		});
	});

	it("falls back from the computed name to the MagicDNS label to the host name", () => {
		expect(parseWhois(JSON.stringify({ Node: { Name: "pixel.tail1234.ts.net." } }))).toMatchObject({
			nodeName: "pixel",
		});
		expect(parseWhois(JSON.stringify({ Node: { Hostinfo: { Hostname: "iPhone" } } }))).toMatchObject({
			nodeName: "iPhone",
		});
		expect(parseWhois(JSON.stringify({ Node: { ComputedName: " " } }))).toEqual({
			nodeId: null,
			nodeName: null,
			login: null,
		});
	});

	it("strips control characters and cuts a long name", () => {
		const parsed = parseWhois(JSON.stringify({ Node: { ComputedName: `a\u0007b\n${"x".repeat(200)}` } }));
		expect(parsed?.nodeName).toMatch(/^abx{78}$/);
	});

	it("keeps only what it needs and tolerates malformed keys", () => {
		const parsed = parseWhois(
			JSON.stringify({ Node: { StableID: 5, ComputedName: "ok", Hostinfo: "nope" }, UserProfile: { LoginName: 7 } }),
		);
		expect(parsed).toEqual({ nodeId: null, nodeName: "ok", login: null });
	});

	it("is null for anything that is not whois output", () => {
		expect(parseWhois("")).toBeNull();
		expect(parseWhois("no match for IP")).toBeNull();
		expect(parseWhois("{}")).toBeNull();
		expect(parseWhois("[]")).toBeNull();
		expect(parseWhois(JSON.stringify({ UserProfile: { LoginName: "a@b.c" } }))).toBeNull();
	});
});
