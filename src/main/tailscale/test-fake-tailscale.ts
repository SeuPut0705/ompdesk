/**
 * Test-only stand-in for the `tailscale` CLI: the scenario a test plays, and `answer`, what the real CLI would
 * print and change for each command Mobile web runs. Vitest drives it in-process through `fakeTailscaleExecutor`;
 * the e2e fake (`e2e/fixture/fake-tailscale.ts`) runs the same `answer` as a real executable over a JSON file.
 * It never touches a real daemon, and it refuses `serve reset` and `funnel` (exit 99) so a regression is loud.
 */
import type { ExecResult, TailscaleExecutor } from "./cli";

export type FakeBackendState =
	| "Running"
	| "NeedsLogin"
	| "Stopped"
	| "NeedsMachineAuth"
	| "Starting"
	| "NoState"
	| "InUseOtherUser";

/** `serve status --json`, in Tailscale's own shape. */
export interface FakeServeConfig {
	TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string }>;
	Web?: Record<string, { Handlers: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
	AllowFunnel?: Record<string, boolean>;
}

export interface FakeTailscaleScenario {
	/** `down`: every command but `version` fails like a Tailscale app that is not running. */
	daemon: "up" | "down";
	backendState: FakeBackendState;
	/** `Version` of `status --json` (the fake appends `-tfake`). */
	version: string;
	/** A newer release exists (`ClientVersion.LatestVersion`); null = running the latest. */
	latestVersion: string | null;
	/** The machine's MagicDNS name with its trailing dot, as Tailscale prints it. */
	dnsName: string;
	/** `MagicDNSSuffix`. */
	tailnet: string;
	/** `User[<userId>].LoginName`: this computer's tailnet user. */
	login: string;
	userId: number;
	/** false: `CertDomains` is empty and `serve --https` fails with the "enable HTTPS" page. */
	httpsEnabled: boolean;
	/** false: `CurrentTailnet.MagicDNSEnabled` is false. */
	magicDns: boolean;
	/** false: `Self.Capabilities` has no `https`. */
	httpsCapability: boolean;
	/** The sign-in page `status --json` and `up` report while `NeedsLogin`. */
	authUrl: string | null;
	/** This machine's tailnet addresses while running (`TailscaleIPs`); default `["100.64.0.1"]`. */
	selfIps?: string[];
	/** This machine's stable node ID (`Self.ID`); default `nfake`. */
	selfStableId?: string;
	/** `ip` is the node's tailnet address (what serve puts in `X-Forwarded-For` and `whois` is asked about). */
	peers: Array<{
		hostName: string;
		os: string;
		online: boolean;
		userId: number;
		ip?: string;
		stableId?: string;
		login?: string;
	}>;
	/** What `serve status --json` answers. Starts with the user's own `443 → http://127.0.0.1:3010`. */
	serve: FakeServeConfig;
	/** Set: every `serve` that writes fails with exactly this stderr (a policy block, another Windows user). */
	serveError: string | null;
	/** What `up` does while `Stopped`: `Running` (it works) or `stay` (nothing changes). */
	upResult: "Running" | "stay";
	/** What the "start the app" stand-in leaves the daemon in. */
	afterStart: FakeBackendState;
	/** `debug prefs` `ControlURL`: a self-hosted control server; null = Tailscale's own. */
	controlUrl: string | null;
}

/** The user's own serve handler every scenario starts with: `https://<host>:443 → http://127.0.0.1:3010`. */
export const USER_SERVE_HOST = "laptop.tail1234.ts.net";
export const USER_SERVE: FakeServeConfig = {
	TCP: { "443": { HTTPS: true } },
	Web: { [`${USER_SERVE_HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3010" } } } },
};

/** A signed-in, HTTPS-enabled Tailscale that already serves the user's 443 → 3010 and has an iPhone online. */
export function defaultTailscaleScenario(overrides: Partial<FakeTailscaleScenario> = {}): FakeTailscaleScenario {
	return {
		daemon: "up",
		backendState: "Running",
		version: "1.104.1",
		latestVersion: null,
		dnsName: `${USER_SERVE_HOST}.`,
		tailnet: "tail1234.ts.net",
		login: "seuput@example.com",
		userId: 1001,
		httpsEnabled: true,
		magicDns: true,
		httpsCapability: true,
		authUrl: "https://login.tailscale.com/a/fake0123456789",
		peers: [
			{ hostName: "iphone", os: "iOS", online: true, userId: 1001, ip: "100.64.0.9", stableId: "nIPHONE1CNTRL" },
		],
		serve: structuredClone(USER_SERVE),
		serveError: null,
		upResult: "Running",
		afterStart: "Running",
		controlUrl: null,
		...overrides,
	};
}

export interface FakeAnswer {
	code: number;
	stdout: string;
	stderr: string;
	/** The scenario was changed (a `serve` or `up` took effect). */
	changed: boolean;
}

const HTTPS_OFF_TEXT =
	"Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=fake\n";

function reply(code: number, stdout = "", stderr = "", changed = false): FakeAnswer {
	return { code, stdout, stderr, changed };
}

function statusJson(s: FakeTailscaleScenario): string {
	const host = s.dnsName.replace(/\.$/, "");
	const hasNode = s.backendState !== "NeedsLogin" && s.backendState !== "NoState";
	const running = s.backendState === "Running";
	const capabilities = ["funnel", "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000"];
	if (s.httpsCapability) capabilities.unshift("https");
	const peers = Object.fromEntries(
		s.peers.map((peer, index) => [
			`nodekey:fake${index}`,
			{
				ID: peer.stableId ?? `nFAKE${peer.hostName}`,
				HostName: peer.hostName,
				DNSName: `${peer.hostName}.${s.tailnet}.`,
				OS: peer.os,
				UserID: peer.userId,
				Online: peer.online,
				TailscaleIPs: peer.ip ? [peer.ip] : [],
			},
		]),
	);
	const users: Record<string, { ID: number; LoginName: string; DisplayName: string }> = {};
	for (const peer of s.peers) {
		if (peer.userId !== s.userId) {
			users[String(peer.userId)] = {
				ID: peer.userId,
				LoginName: peer.login ?? "other@example.com",
				DisplayName: "",
			};
		}
	}
	users[String(s.userId)] = { ID: s.userId, LoginName: s.login, DisplayName: "Fake User" };
	return `${JSON.stringify(
		{
			Version: `${s.version}-tfake`,
			TUN: true,
			BackendState: s.backendState,
			HaveNodeKey: hasNode,
			AuthURL: s.backendState === "NeedsLogin" ? (s.authUrl ?? "") : "",
			TailscaleIPs: running ? (s.selfIps ?? ["100.64.0.1"]) : null,
			Self: hasNode
				? {
						ID: s.selfStableId ?? "nfake",
						HostName: "laptop",
						DNSName: s.dnsName,
						OS: "macOS",
						UserID: s.userId,
						Online: running,
						KeyExpiry: "2027-04-01T00:00:00Z",
						Capabilities: capabilities,
					}
				: null,
			Health: [],
			MagicDNSSuffix: s.tailnet,
			CurrentTailnet: hasNode ? { Name: s.login, MagicDNSSuffix: s.tailnet, MagicDNSEnabled: s.magicDns } : null,
			CertDomains: running && s.httpsEnabled ? [host] : null,
			Peer: running ? peers : undefined,
			User: hasNode ? users : undefined,
			ClientVersion: s.latestVersion
				? { LatestVersion: s.latestVersion, RunningLatest: false }
				: { RunningLatest: true },
		},
		null,
		2,
	)}\n`;
}

/** `--https=<port>` of a serve command, or null. */
function httpsPort(args: string[]): number | null {
	for (const arg of args) {
		const match = /^--https=(\d+)$/.exec(arg);
		if (match) return Number(match[1]);
	}
	return null;
}

function removePort(config: FakeServeConfig, port: number): boolean {
	let removed = false;
	if (config.TCP && String(port) in config.TCP) {
		delete config.TCP[String(port)];
		removed = true;
	}
	for (const table of [config.Web, config.AllowFunnel]) {
		if (!table) continue;
		for (const key of Object.keys(table)) {
			if (key.endsWith(`:${port}`)) {
				delete table[key];
				removed = true;
			}
		}
	}
	return removed;
}

function answerServe(rest: string[], s: FakeTailscaleScenario): FakeAnswer {
	const host = s.dnsName.replace(/\.$/, "");
	if (rest[0] === "status" && rest.includes("--json")) {
		const config = s.serve;
		const empty = !config.TCP && !config.Web && !config.AllowFunnel;
		return reply(0, empty ? "{}\n" : `${JSON.stringify(config, null, 2)}\n`);
	}
	if (rest[0] === "reset") return reply(99, "", "fake-tailscale: `serve reset` is never run by OMPdesk\n");
	const port = httpsPort(rest);
	if (port !== null && rest.includes("off")) {
		if (s.serveError) return reply(1, "", s.serveError);
		if (!removePort(s.serve, port)) return reply(1, "", "error: handler does not exist\n");
		return reply(0, "", "", true);
	}
	const target = rest.find(arg => /^https?:\/\//.test(arg));
	if (port !== null && target) {
		if (s.serveError) return reply(1, "", s.serveError);
		if (!s.httpsEnabled) return reply(1, "", HTTPS_OFF_TEXT);
		const config = s.serve;
		config.TCP = { ...config.TCP, [String(port)]: { HTTPS: true } };
		config.Web = { ...config.Web, [`${host}:${port}`]: { Handlers: { "/": { Proxy: target } } } };
		// Configuring a port with serve makes it private again, as the real CLI does.
		if (config.AllowFunnel) delete config.AllowFunnel[`${host}:${port}`];
		return reply(
			0,
			`Available within your tailnet:\n\nhttps://${host}:${port}/\n|-- proxy ${target}\n\nServe started and running in the background.\n`,
			"",
			true,
		);
	}
	return reply(1, "", `fake-tailscale: unsupported serve invocation: ${rest.join(" ")}\n`);
}

/** What `tailscale <argv>` prints and changes in `scenario` (mutated in place). */
export function answer(argv: string[], scenario: FakeTailscaleScenario): FakeAnswer {
	const [command, ...rest] = argv;
	if (command === "version") return reply(0, `${scenario.version}\n  tailscale commit: fake\n`);
	if (scenario.daemon === "down") {
		return reply(1, "", "failed to connect to local Tailscale service; is Tailscale running?\n");
	}
	if (command === "status" && rest.includes("--json")) return reply(0, statusJson(scenario));
	if (command === "serve") return answerServe(rest, scenario);
	if (command === "whois") {
		const ip = rest.find(arg => !arg.startsWith("-"));
		const peer = scenario.peers.find(candidate => candidate.ip !== undefined && candidate.ip === ip);
		if (!peer) return reply(1, "", `fake-tailscale: no match for IP ${ip ?? ""}\n`);
		const login = peer.login ?? (peer.userId === scenario.userId ? scenario.login : "other@example.com");
		return reply(
			0,
			`${JSON.stringify({
				Node: {
					StableID: peer.stableId ?? `nFAKE${peer.hostName}`,
					Name: `${peer.hostName}.${scenario.tailnet}.`,
					ComputedName: peer.hostName,
					Hostinfo: { Hostname: peer.hostName, OS: peer.os },
				},
				UserProfile: { LoginName: login },
			})}\n`,
		);
	}
	if (command === "funnel") return reply(99, "", "fake-tailscale: `funnel` is never run by OMPdesk\n");
	if (command === "debug" && rest[0] === "prefs") {
		return reply(
			0,
			`${JSON.stringify({ ControlURL: scenario.controlUrl ?? "https://controlplane.tailscale.com" })}\n`,
		);
	}
	if (command === "up") {
		const json = rest.includes("--json");
		if (scenario.backendState === "NeedsLogin") {
			const url = scenario.authUrl ?? "";
			return json
				? reply(0, `${JSON.stringify({ AuthURL: url, BackendState: "NeedsLogin" })}\n`)
				: reply(0, "", `\nTo authenticate, visit:\n\n\t${url}\n\n`);
		}
		if (scenario.backendState === "Stopped" && scenario.upResult === "Running") {
			scenario.backendState = "Running";
			return reply(0, "", "", true);
		}
		return reply(0);
	}
	return reply(1, "", `fake-tailscale: unsupported command: ${argv.join(" ")}\n`);
}

/** The "start the Tailscale app" stand-in: the daemon comes up in `afterStart`. */
export function startFakeApp(scenario: FakeTailscaleScenario): void {
	scenario.daemon = "up";
	scenario.backendState = scenario.afterStart;
}

/** An executor over `scenario` (mutated by `serve`/`up`); `calls` collects every argv it was given. */
export function fakeTailscaleExecutor(scenario: FakeTailscaleScenario, calls: string[][] = []): TailscaleExecutor {
	return async (_file, args) => {
		calls.push(args);
		const { code, stdout, stderr } = answer(args, scenario);
		return { code, stdout, stderr, timedOut: false, spawnError: null } satisfies ExecResult;
	};
}
