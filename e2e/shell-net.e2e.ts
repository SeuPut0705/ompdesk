import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp } from "./harness";

// `net.request` as electron-updater uses it: HTTP authentication through the `login` event (a server's 401 and a
// proxy's 407), and a request on its own session going through that session's proxy.

let app: ElectronApplication;
let profile: string;
let server: http.Server;
let origin: string;
const seen: { path: string; authorization?: string; proxyAuthorization?: string }[] = [];

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-net-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	// One server that is a site (401 with a Basic challenge on /site) and a proxy (407 on any absolute-form request).
	server = http.createServer((request, response) => {
		const absolute = request.url?.startsWith("http://") === true;
		seen.push({
			path: request.url ?? "",
			authorization: request.headers.authorization,
			proxyAuthorization: request.headers["proxy-authorization"] as string | undefined,
		});
		if (absolute) {
			if (request.headers["proxy-authorization"] === basic("proxy-user", "proxy-pass")) {
				response.writeHead(200, { "content-type": "text/plain" }).end("through the proxy");
				return;
			}
			response.writeHead(407, { "proxy-authenticate": 'Basic realm="corp-proxy"', "content-length": "0" }).end();
			return;
		}
		if (request.headers.authorization === basic("site-user", "site-pass")) {
			response.writeHead(200, { "content-type": "text/plain" }).end("the site");
			return;
		}
		response.writeHead(401, { "www-authenticate": 'Basic realm="the-site"', "content-length": "0" }).end();
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
	app = await launchApp({ project, desktop: userData, agent, profile });
	await app.firstWindow();
});

test.afterAll(async () => {
	if (app) await exitApp(app);
	server?.close();
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Outcome {
	status: number;
	body: string;
	challenges: unknown[];
}

/** One `net.request` made in main; `answer` is what the `login` listener does (absent: no listener). */
async function request(options: {
	url: string;
	partition?: string;
	proxy?: string;
	answer?: { username: string; password: string } | "empty";
}): Promise<Outcome> {
	return app.evaluate(async ({ net, session }, { url, partition, proxy, answer }) => {
		const owner = partition ? session.fromPartition(partition, { cache: false }) : undefined;
		if (owner && proxy) await owner.setProxy({ mode: "fixed_servers", proxyRules: proxy });
		const challenges: unknown[] = [];
		return await new Promise<{ status: number; body: string; challenges: unknown[] }>((resolve, reject) => {
			const req = net.request({ url, ...(owner ? { session: owner } : {}) });
			if (answer)
				req.on("login", (info: unknown, callback: (username?: string, password?: string) => void) => {
					challenges.push(info);
					if (answer === "empty") callback();
					else callback(answer.username, answer.password);
				});
			req.on("response", response => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), challenges }),
				);
			});
			req.on("error", reject);
			req.end();
		});
	}, options);
}

test("a server's 401 is answered through the login event, with Electron's authInfo", async () => {
	const outcome = await request({
		url: `http://${origin}/site`,
		answer: { username: "site-user", password: "site-pass" },
	});
	expect(outcome).toMatchObject({ status: 200, body: "the site" });
	expect(outcome.challenges[0]).toEqual({
		isProxy: false,
		scheme: "basic",
		host: "127.0.0.1",
		port: Number(origin.split(":")[1]),
		realm: "the-site",
	});
});

test("a login callback with nothing, or no listener, leaves the 401 as the response", async () => {
	expect((await request({ url: `http://${origin}/site`, answer: "empty" })).status).toBe(401);
	expect((await request({ url: `http://${origin}/site` })).status).toBe(401);
});

test("a proxy's 407 is answered through the login event on a session's own proxy", async () => {
	const outcome = await request({
		url: "http://updates.example.invalid/installer",
		partition: "electron-updater",
		proxy: `http=${origin}`,
		answer: { username: "proxy-user", password: "proxy-pass" },
	});
	expect(outcome).toMatchObject({ status: 200, body: "through the proxy" });
	expect(outcome.challenges[0]).toMatchObject({ isProxy: true, scheme: "basic", realm: "corp-proxy" });
	expect(seen.some(entry => entry.proxyAuthorization === basic("proxy-user", "proxy-pass"))).toBe(true);
});
