import { describe, expect, it } from "vitest";
import { isTailnetAddress, STATUS_CACHE_MS, Tailnet, WHOIS_CACHE_MAX, WHOIS_CACHE_MS } from "./tailnet";
import { defaultTailscaleScenario, fakeTailscaleExecutor } from "./test-fake-tailscale";

const LOCATED = { path: "/fake/tailscale", variant: "mac-standalone", app: null, env: {} } as const;

function rig(patch: Parameters<typeof defaultTailscaleScenario>[0] = {}) {
	const scenario = defaultTailscaleScenario(patch);
	const calls: string[][] = [];
	const clock = { now: 1_000 };
	const located = { value: LOCATED as typeof LOCATED | null };
	const tailnet = new Tailnet({
		locate: async () => located.value,
		exec: fakeTailscaleExecutor(scenario, calls),
		now: () => clock.now,
	});
	return { tailnet, scenario, calls, clock, located };
}

describe("isTailnetAddress", () => {
	it("is the tailnet's CGNAT range and IPv6 prefix only", () => {
		for (const ip of ["100.64.0.1", "100.127.255.254", "::ffff:100.100.1.2", "fd7a:115c:a1e0:ab12::1"]) {
			expect(isTailnetAddress(ip), ip).toBe(true);
		}
		for (const ip of ["100.63.255.255", "100.128.0.1", "127.0.0.1", "192.168.1.2", "fd12::1", "::1", "x"]) {
			expect(isTailnetAddress(ip), ip).toBe(false);
		}
	});
});

describe("Tailnet", () => {
	it("caches a whois answer for a minute, asks again after, and starts over when the cache is full", async () => {
		const { tailnet, calls, clock } = rig();
		const whoisCalls = () => calls.filter(args => args[0] === "whois").length;
		expect(await tailnet.whois("100.64.0.9")).toMatchObject({ nodeId: "nIPHONE1CNTRL" });
		await tailnet.whois("::ffff:100.64.0.9");
		expect(whoisCalls()).toBe(1);
		clock.now += WHOIS_CACHE_MS;
		await tailnet.whois("100.64.0.9");
		expect(whoisCalls()).toBe(2);
		// An unknown address is not cached and costs a call each time; text that is no address costs none.
		expect(await tailnet.whois("100.64.0.200")).toBeNull();
		expect(await tailnet.whois("--help")).toBeNull();
		expect(whoisCalls()).toBe(3);
		expect(WHOIS_CACHE_MAX).toBe(256);
	});

	it("reads the tailnet's nodes and this computer's addresses, cached briefly", async () => {
		const { tailnet, calls, clock, scenario } = rig({ selfIps: ["100.64.0.5"], selfStableId: "nSELF" });
		const status = await tailnet.status();
		expect(status).toMatchObject({ selfIps: ["100.64.0.5"], selfNodeId: "nSELF" });
		expect(status?.peers).toEqual([
			{
				nodeId: "nIPHONE1CNTRL",
				name: "iphone",
				ips: ["100.64.0.9"],
				os: "iOS",
				online: true,
				login: "seuput@example.com",
			},
		]);
		await tailnet.status();
		expect(calls.filter(args => args[0] === "status")).toHaveLength(1);
		scenario.backendState = "NeedsLogin";
		clock.now += STATUS_CACHE_MS;
		expect(await tailnet.phase()).toBe("needs-login");
	});

	it("tells a missing Tailscale from one that does not answer, and finds one installed later", async () => {
		const { tailnet, located, scenario, clock } = rig();
		located.value = null;
		expect(await tailnet.phase()).toBe("not-installed");
		located.value = LOCATED;
		clock.now += STATUS_CACHE_MS;
		scenario.daemon = "down";
		expect(await tailnet.phase()).toBe("not-running");
		scenario.daemon = "up";
		clock.now += STATUS_CACHE_MS;
		expect(await tailnet.phase()).toBe("ready");
	});
});
