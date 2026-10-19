import { describe, expect, it } from "vitest";
import { authUrlFromUpJson, controlHostFromPrefs, extractLoginUrl, loginUrlAllowed } from "./cli";
import { httpsProblem, parseStatus } from "./status";
import { answer, defaultTailscaleScenario } from "./test-fake-tailscale";

const json = (overrides = {}) => answer(["status", "--json"], defaultTailscaleScenario(overrides)).stdout;

describe("parseStatus", () => {
	it("reads only the keys it needs from a running Tailscale", () => {
		const status = parseStatus(json());
		expect(status).toEqual({
			backendState: "Running",
			backend: "running",
			version: "1.104.1",
			authUrl: null,
			dnsName: "laptop.tail1234.ts.net",
			userId: 1001,
			login: "seuput@example.com",
			certDomains: ["laptop.tail1234.ts.net"],
			magicDns: true,
			capabilities: ["https", "funnel", "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000"],
			keyExpiry: "2027-04-01T00:00:00Z",
			updateAvailable: false,
			phones: ["iphone"],
			selfIps: ["100.64.0.1"],
			selfNodeId: "nfake",
			selfName: "laptop",
			peers: [
				{
					nodeId: "nIPHONE1CNTRL",
					name: "iphone",
					ips: ["100.64.0.9"],
					os: "iOS",
					online: true,
					login: "seuput@example.com",
				},
			],
		});
		expect(httpsProblem(status as NonNullable<typeof status>)).toBeNull();
	});

	it("lists only this user's online phones and tablets", () => {
		const status = parseStatus(
			json({
				peers: [
					{ hostName: "iphone", os: "iOS", online: true, userId: 1001 },
					{ hostName: "ipad", os: "iPadOS", online: true, userId: 1001 },
					{ hostName: "pixel", os: "android", online: true, userId: 1001 },
					{ hostName: "asleep", os: "iOS", online: false, userId: 1001 },
					{ hostName: "friends-phone", os: "iOS", online: true, userId: 2002 },
					{ hostName: "desktop", os: "linux", online: true, userId: 1001 },
				],
			}),
		);
		expect(status?.phones).toEqual(["iphone", "ipad", "pixel"]);
	});

	it("reads signed-out and newer-version documents", () => {
		const out = parseStatus(json({ backendState: "NeedsLogin", latestVersion: "1.106.0" }));
		expect(out).toMatchObject({
			backend: "needs-login",
			authUrl: "https://login.tailscale.com/a/fake0123456789",
			dnsName: null,
			login: null,
			updateAvailable: true,
		});
		expect(parseStatus(json({ backendState: "NeedsMachineAuth" }))?.backend).toBe("needs-machine-auth");
		expect(parseStatus('{"BackendState":"SomethingNew"}')?.backend).toBe("unknown");
	});

	it("ignores unknown keys and a key of the wrong shape instead of failing", () => {
		const status = parseStatus(
			JSON.stringify({
				BackendState: "Running",
				Brand: "new",
				Self: { DNSName: "a.b.ts.net.", UserID: "not a number", Capabilities: 5 },
				CertDomains: "nope",
				Peer: { x: { OS: 7 } },
			}),
		);
		expect(status).toMatchObject({
			backend: "running",
			dnsName: "a.b.ts.net",
			userId: null,
			certDomains: [],
			phones: [],
		});
	});

	it("is null for anything that is not a status document", () => {
		for (const text of ["", "Tailscale is stopped.", "[]", "{}", '{"BackendState":3}'])
			expect(parseStatus(text)).toBeNull();
	});

	it("names why HTTPS cannot work", () => {
		const problem = (overrides: object) => {
			const status = parseStatus(json(overrides));
			return status ? httpsProblem(status) : "unparsed";
		};
		expect(problem({ httpsEnabled: false })).toContain("certificates");
		expect(problem({ magicDns: false })).toContain("MagicDNS");
		expect(problem({ httpsCapability: false })).toContain("https capability");
	});
});

describe("cli helpers", () => {
	it("finds the login.tailscale.com link in human output and nothing else", () => {
		expect(extractLoginUrl("To enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=n1\n")).toBe(
			"https://login.tailscale.com/f/serve?node=n1",
		);
		expect(extractLoginUrl("visit https://evil.example.com/login.tailscale.com/x")).toBeNull();
		expect(extractLoginUrl("no link here")).toBeNull();
	});

	it("takes the sign-in link out of `up --json` lines, tolerating a cut-off one", () => {
		expect(authUrlFromUpJson('{"AuthURL":"https://login.tailscale.com/a/1","BackendState":"NeedsLogin"}\n')).toBe(
			"https://login.tailscale.com/a/1",
		);
		expect(authUrlFromUpJson('{"BackendState":"Starting"}\n{"AuthURL":"https://x.example/a"}\n{"Auth')).toBe(
			"https://x.example/a",
		);
		expect(authUrlFromUpJson("garbage")).toBeNull();
	});

	it("only allows https on Tailscale's login host or the tailnet's control host", () => {
		expect(loginUrlAllowed("https://login.tailscale.com/a/x", null)).toBe(true);
		expect(loginUrlAllowed("https://LOGIN.tailscale.com/a/x", null)).toBe(true);
		expect(loginUrlAllowed("http://login.tailscale.com/a/x", null)).toBe(false);
		expect(loginUrlAllowed("https://login.tailscale.com.evil.example/a", null)).toBe(false);
		expect(loginUrlAllowed("https://user:pw@login.tailscale.com/a", null)).toBe(false);
		expect(loginUrlAllowed("javascript:alert(1)", null)).toBe(false);
		expect(loginUrlAllowed("https://hs.example.org/register/x", null)).toBe(false);
		expect(loginUrlAllowed("https://hs.example.org/register/x", "hs.example.org")).toBe(true);
		expect(loginUrlAllowed("not a url", "hs.example.org")).toBe(false);
	});

	it("reads the control server's host from `debug prefs`", () => {
		expect(controlHostFromPrefs('{"ControlURL":"https://hs.example.org:8080"}')).toBe("hs.example.org");
		expect(controlHostFromPrefs("{}")).toBeNull();
		expect(controlHostFromPrefs("nope")).toBeNull();
	});
});
