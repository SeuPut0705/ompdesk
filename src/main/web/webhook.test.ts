/**
 * `POST /hooks/<schedule id>` on the real web server and the real schedule service: reached on the loopback address
 * itself (a script on this computer, the key its only credential) and through serve's secret prefix (the existing
 * walls: an allowed Tailscale login). Only Electron is faked; the launcher records what each run was told.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduleDraft } from "../../shared/schedules";
import { type RunLauncher, ScheduleService } from "../schedules";
import type { ClientWindow } from "./client-window";
import type { IpcCaller } from "./ipc-registry";
import { WebHost } from "./web-host";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const LOGIN = "me@example.com";
const IDENTITY: Record<string, string> = { "tailscale-user-login": LOGIN, "x-forwarded-for": "100.64.0.9" };
const KEY = "k".repeat(32);

let userData: string;
let staticRoot: string;
let host: WebHost;
let service: ScheduleService | null;
let port: number;
let prompts: string[];
let hooksAvailable: boolean;

const desktop = (): ClientWindow => ({
	webContents: { id: 1, send: () => undefined },
	isDestroyed: () => false,
	once: () => undefined,
	removeListener: () => undefined,
});

beforeEach(async () => {
	userData = mkdtempSync(join(tmpdir(), "web-hook-"));
	staticRoot = mkdtempSync(join(tmpdir(), "web-hook-static-"));
	mkdirSync(join(staticRoot, "assets"));
	writeFileSync(join(staticRoot, "web.html"), "<!doctype html>");
	prompts = [];
	hooksAvailable = true;
	const launch: RunLauncher = async (_schedule, files) => {
		prompts.push(readFileSync(files.prompt, "utf8"));
		return { stop: () => undefined, done: new Promise(() => undefined) };
	};
	service = new ScheduleService({
		file: join(userData, "schedules.json"),
		logDir: join(userData, "runs"),
		launch,
		onState: () => undefined,
		tickMs: 3_600_000,
	});
	await service.start();
	host = new WebHost({
		ipc: { handle: () => undefined, invoke: async () => undefined, send: () => undefined },
		userData,
		staticRoot: () => staticRoot,
		desktopWindows: () => [desktop() as ClientWindow & IpcCaller],
		tabs: { activeTab: () => null, cwd: () => null, facts: () => null, resnapshot: () => undefined },
		openMedia: async () => new Response(null, { status: 404 }),
		shell: { openPath: async () => undefined, reveal: () => undefined, openExternal: async () => undefined },
		allowedUsers: () => [LOGIN],
		confirmNewDevices: () => false,
		whois: async () => null,
		onUnpairedAuth: () => undefined,
		language: () => "en",
		hooks: () => (hooksAvailable ? service : null),
	});
	({ port } = await host.start({ port: 0 }));
	host.server.configure({ host: "127.0.0.1", publicPort: port, secure: false, servePrefix: SECRET });
});

afterEach(async () => {
	await host.stop();
	service?.dispose();
	rmSync(userData, { recursive: true, force: true });
	rmSync(staticRoot, { recursive: true, force: true });
});

async function routine(extra: Partial<ScheduleDraft> = {}): Promise<string> {
	const created = await service?.create({
		name: "Hooked",
		prompt: "Handle the call",
		cwd: userData,
		frequency: { kind: "event", event: { source: "webhook", key: KEY } },
		model: null,
		autoApprove: false,
		enabled: true,
		...extra,
	});
	if (!created) throw new Error("no service");
	return created.id;
}

interface Reply {
	status: number;
	body: string;
}

function request(options: {
	path: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | Buffer;
}): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	const req = http.request(
		{ host: "127.0.0.1", port, path: options.path, method: options.method ?? "POST", headers: options.headers },
		res => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(chunk as Buffer));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
		},
	);
	req.on("error", reject);
	req.end(options.body);
	return promise;
}

const bearer = (key = KEY) => ({ authorization: `Bearer ${key}` });
/** A script on this computer: no prefix, the loopback `Host`, no browser headers. */
const direct = (id: string, headers: Record<string, string> = bearer(), body?: string) =>
	request({
		path: `/hooks/${id}`,
		headers: { host: `127.0.0.1:${port}`, ...headers },
		...(body === undefined ? {} : { body }),
	});
/** A call through `tailscale serve`: the secret prefix and the identity headers serve adds. */
const throughServe = (id: string, headers: Record<string, string> = bearer(), body?: string) =>
	request({
		path: `/${SECRET}/hooks/${id}`,
		headers: { host: `127.0.0.1:${port}`, ...IDENTITY, ...headers },
		...(body === undefined ? {} : { body }),
	});

describe("POST /hooks/<id> on the loopback address", () => {
	it("answers 202 and starts the routine with the first 400 characters of the body, one line", async () => {
		const id = await routine();
		const body = `{"a": 1,\n  "b": "${"x".repeat(600)}"}`;
		const reply = await direct(id, { ...bearer(), "content-type": "application/json" }, body);
		expect(reply.status).toBe(202);
		await expect.poll(() => prompts.length).toBe(1);
		const told = prompts[0]?.split("What fired this run:\n")[1] ?? "";
		expect(told.startsWith('Webhook call: {"a": 1, "b": "xxx')).toBe(true);
		expect(told).toHaveLength("Webhook call: ".length + 400);
	});

	it("tells a call with no body so, and keeps a call made while the run goes for one more run", async () => {
		const id = await routine();
		expect((await direct(id)).status).toBe(202);
		await expect.poll(() => prompts.length).toBe(1);
		expect(prompts[0]).toContain("Webhook call with no body");
		expect((await direct(id, bearer(), "again")).status).toBe(202);
		expect(prompts).toHaveLength(1);
	});

	it("answers 401 for a wrong or missing key and never starts the routine", async () => {
		const id = await routine();
		expect((await direct(id, bearer("wrong".padEnd(32, "w")))).status).toBe(401);
		expect((await direct(id, bearer(`${KEY}x`))).status).toBe(401);
		expect((await direct(id, bearer(KEY.slice(1)))).status).toBe(401);
		expect((await direct(id, {})).status).toBe(401);
		expect((await direct(id, { authorization: `Basic ${KEY}` })).status).toBe(401);
		expect((await direct(id, { authorization: KEY })).status).toBe(401);
		expect(prompts).toEqual([]);
		expect(service?.state().runs).toEqual([]);
	});

	it("answers 404 for an unknown routine, a routine of another trigger and an id that cannot be one", async () => {
		const timed = await routine({ frequency: { kind: "interval", minutes: 30 } });
		expect((await direct("00000000-0000-4000-8000-000000000000")).status).toBe(404);
		expect((await direct(timed)).status).toBe(404);
		expect((await direct("..%2F..%2Fapi")).status).toBe(404);
		expect(prompts).toEqual([]);
	});

	it("answers 409 for a routine that is turned off, with the right key", async () => {
		const id = await routine({ enabled: false });
		expect((await direct(id)).status).toBe(409);
		expect(prompts).toEqual([]);
	});

	it("takes only POST, a body up to 64 KiB, and a service that exists", async () => {
		const id = await routine();
		expect(
			(await request({ path: `/hooks/${id}`, method: "GET", headers: { host: `127.0.0.1:${port}`, ...bearer() } }))
				.status,
		).toBe(405);
		expect((await direct(id, bearer(), "z".repeat(64 * 1024 + 1))).status).toBe(413);
		expect(prompts).toEqual([]);
		hooksAvailable = false;
		expect((await direct(id)).status).toBe(503);
	});

	it("refuses what a browser sends and a Host that is not the loopback address", async () => {
		const id = await routine();
		expect((await direct(id, { ...bearer(), origin: "https://evil.example" })).status).toBe(403);
		expect((await direct(id, { ...bearer(), "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect((await direct(id, { ...bearer(), host: "evil.example" })).status).toBe(421);
		expect((await direct(id, { ...bearer(), host: `127.0.0.1:${port + 1}` })).status).toBe(421);
		expect(prompts).toEqual([]);
		expect((await direct(id, { ...bearer(), host: `localhost:${port}` })).status).toBe(202);
	});

	it("serves nothing else without the serve prefix", async () => {
		const reply = await request({ path: "/api/session", headers: { host: `127.0.0.1:${port}`, ...IDENTITY } });
		expect(reply.status).toBe(404);
	});
});

describe("POST /hooks/<id> through serve", () => {
	it("passes the existing walls and needs no Origin: 202 with the key, 401 without it", async () => {
		const id = await routine();
		expect((await throughServe(id, bearer("wrong".padEnd(32, "w")))).status).toBe(401);
		expect(prompts).toEqual([]);
		expect((await throughServe(id, bearer(), "from the tailnet")).status).toBe(202);
		await expect.poll(() => prompts.length).toBe(1);
		expect(prompts[0]).toContain("Webhook call: from the tailnet");
	});

	it("refuses a login that is not allowed, a tagged node, a wrong Origin and a cross-site request before the key is looked at", async () => {
		const id = await routine();
		const call = (headers: Record<string, string>) =>
			request({ path: `/${SECRET}/hooks/${id}`, headers: { host: `127.0.0.1:${port}`, ...bearer(), ...headers } });
		expect((await call({ ...IDENTITY, "tailscale-user-login": "stranger@example.com" })).status).toBe(403);
		expect((await call({ "x-forwarded-for": "100.64.0.9" })).status).toBe(403);
		expect((await call({ ...IDENTITY, origin: "https://evil.example" })).status).toBe(403);
		expect((await call({ ...IDENTITY, "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect(prompts).toEqual([]);
	});
});
