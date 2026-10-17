import { describe, expect, it } from "vitest";
import {
	funnelOn,
	handlerIsOurs,
	ownProxy,
	parseServeStatus,
	planPublish,
	portTaken,
	readServeRecord,
	sameServeConfig,
	withoutPort,
} from "./serve";

const HOST = "laptop.tail1234.ts.net";
const TARGET = "http://127.0.0.1:51000";
const config = (value: unknown) => {
	const parsed = parseServeStatus(JSON.stringify(value));
	if (!parsed) throw new Error("not a serve config");
	return parsed;
};
const proxy = (url: string) => ({ Handlers: { "/": { Proxy: url } } });
const userOnly = {
	TCP: { "443": { HTTPS: true } },
	Web: { [`${HOST}:443`]: proxy("http://127.0.0.1:3010") },
};

describe("parseServeStatus", () => {
	it("reads an empty answer as an empty config and refuses text that is not JSON", () => {
		expect(parseServeStatus("")?.web.size).toBe(0);
		expect(parseServeStatus("{}\n")?.tcpPorts.size).toBe(0);
		expect(parseServeStatus("No serve config")).toBeNull();
		expect(parseServeStatus("[]")).toBeNull();
	});

	it("keeps ports, handlers and Funnel flags, and marks non-proxy handlers", () => {
		const parsed = config({
			TCP: { "443": { HTTPS: true }, "8080": { TCPForward: "127.0.0.1:1" } },
			Web: {
				[`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3010" }, "/files": { Path: "/tmp" } } },
			},
			AllowFunnel: { [`${HOST}:443`]: true, [`${HOST}:8443`]: false },
			Unknown: 1,
		});
		expect([...parsed.tcpPorts]).toEqual([443, 8080]);
		expect(parsed.web.get(`${HOST}:443`)?.get("/")).toEqual({ proxy: "http://127.0.0.1:3010", other: false });
		expect(parsed.web.get(`${HOST}:443`)?.get("/files")).toEqual({ proxy: null, other: true });
		expect([...parsed.funnel]).toEqual([`${HOST}:443`]);
		expect(funnelOn(parsed, HOST, 443)).toBe(true);
		expect(funnelOn(parsed, HOST, 8443)).toBe(false);
	});
});

describe("ownership", () => {
	const record = { host: HOST, port: 47831, target: TARGET };

	it("is ours only for exactly one `/` proxy to the recorded target", () => {
		const ours = config({ Web: { [`${HOST}:47831`]: proxy(TARGET) } });
		expect(handlerIsOurs(ours, record, `${TARGET}/s3cr3t`)).toBe(true);
		expect(
			handlerIsOurs(config({ Web: { [`${HOST}:47831`]: proxy("http://127.0.0.1:1") } }), record, `${TARGET}/s3cr3t`),
		).toBe(false);
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47832`]: proxy(TARGET) } }), record, `${TARGET}/s3cr3t`)).toBe(
			false,
		);
		expect(handlerIsOurs(config({}), record, `${TARGET}/s3cr3t`)).toBe(false);
		const extra = { Handlers: { "/": { Proxy: TARGET }, "/x": { Proxy: TARGET } } };
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47831`]: extra } }), record, `${TARGET}/s3cr3t`)).toBe(false);
		const path = { Handlers: { "/": { Path: "/tmp", Proxy: TARGET } } };
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47831`]: path } }), record, `${TARGET}/s3cr3t`)).toBe(false);
	});

	it("reads a record only in its exact shape", () => {
		expect(readServeRecord(record)).toEqual(record);
		for (const bad of [
			null,
			"x",
			{},
			{ ...record, port: 0 },
			{ ...record, port: 1.5 },
			{ ...record, host: "" },
			{ ...record, target: 1 },
		]) {
			expect(readServeRecord(bad)).toBeNull();
		}
	});

	it("turning ours off leaves everything else equal, and a changed rest is noticed", () => {
		const before = config({
			TCP: { "443": { HTTPS: true }, "47831": { HTTPS: true } },
			Web: { [`${HOST}:443`]: proxy("http://127.0.0.1:3010"), [`${HOST}:47831`]: proxy(TARGET) },
		});
		const clean = config(userOnly);
		expect(sameServeConfig(clean, withoutPort(before, 47831))).toBe(true);
		expect(sameServeConfig(before, withoutPort(before, 47831))).toBe(false);
		const changed = config({ ...userOnly, Web: { [`${HOST}:443`]: proxy("http://127.0.0.1:9999") } });
		expect(sameServeConfig(changed, withoutPort(before, 47831))).toBe(false);
	});
});

describe("planPublish", () => {
	it("takes 47831 when it is free and skips every port something uses", () => {
		expect(planPublish(config(userOnly), HOST, TARGET, null)).toEqual({ kind: "publish", port: 47831 });
		const busy = config({
			TCP: { "47831": { HTTPS: true }, "47832": { TCPForward: "x:1" } },
			Web: { [`${HOST}:47831`]: proxy("http://127.0.0.1:1"), "other.ts.net:47833": proxy("http://127.0.0.1:2") },
		});
		expect(portTaken(busy, 47832)).toBe(true);
		expect(portTaken(busy, 47833)).toBe(true);
		expect(planPublish(busy, HOST, TARGET, null)).toEqual({ kind: "publish", port: 47834 });
	});

	it("never takes over a handler that merely looks like ours when there is no record", () => {
		const lookalike = config({ TCP: { "47831": { HTTPS: true } }, Web: { [`${HOST}:47831`]: proxy(TARGET) } });
		expect(planPublish(lookalike, HOST, TARGET, null)).toEqual({ kind: "publish", port: 47832 });
	});

	it("keeps our own port, leaves it alone for the same target, and rewrites it for a new one", () => {
		const ours = config({ TCP: { "47832": { HTTPS: true } }, Web: { [`${HOST}:47832`]: proxy(TARGET) } });
		const record = { host: HOST, port: 47832, target: TARGET };
		expect(planPublish(ours, HOST, TARGET, record)).toEqual({ kind: "reuse", port: 47832 });
		expect(planPublish(ours, HOST, "http://127.0.0.1:52000", record)).toEqual({ kind: "publish", port: 47832 });
		// A record whose handler is gone is stale: pick a port as if there were none.
		expect(planPublish(config(userOnly), HOST, TARGET, record)).toEqual({ kind: "publish", port: 47831 });
		// A record for another machine name is not this host's handler.
		expect(planPublish(ours, "renamed.ts.net", TARGET, record)).toEqual({ kind: "publish", port: 47831 });
	});

	it("publishes the secret path: reuses a handler that already proxies there, republishes one that does not", () => {
		const withSecret = `${TARGET}/s3cr3t`;
		const record = { host: HOST, port: 47832, target: TARGET };
		const current = config({ TCP: { "47832": { HTTPS: true } }, Web: { [`${HOST}:47832`]: proxy(withSecret) } });
		expect(planPublish(current, HOST, withSecret, record)).toEqual({ kind: "reuse", port: 47832 });
		// An earlier OMPdesk published the bare address; a rotated secret is another path.
		const bare = config({ TCP: { "47832": { HTTPS: true } }, Web: { [`${HOST}:47832`]: proxy(TARGET) } });
		expect(planPublish(bare, HOST, withSecret, record)).toEqual({ kind: "publish", port: 47832 });
		// A handler under another secret is not provably ours (it could be the user's): never reused or overwritten.
		expect(planPublish(current, HOST, `${TARGET}/other`, record)).toEqual({ kind: "publish", port: 47831 });
	});

	it("republishes over our own handler when the app now listens on another local port, never over one without our secret", () => {
		const record = { host: HOST, port: 47832, target: TARGET };
		const oldPort = "http://127.0.0.1:47999";
		const next = "http://127.0.0.1:48123/s3cr3t";
		const at = (proxyUrl: string) =>
			config({ TCP: { "47832": { HTTPS: true } }, Web: { [`${HOST}:47832`]: proxy(proxyUrl) } });
		// The last run proxied to another port under this secret: ours (the secret is ours alone), same serve port.
		expect(ownProxy(at(`${oldPort}/s3cr3t`), record, next)).toBe(`${oldPort}/s3cr3t`);
		expect(planPublish(at(`${oldPort}/s3cr3t`), HOST, next, record)).toEqual({ kind: "publish", port: 47832 });
		// Another secret, a non-loopback host or an https proxy is not ours, whatever its port.
		expect(ownProxy(at(`${oldPort}/other`), record, next)).toBeNull();
		expect(ownProxy(at("http://192.168.1.5:47999/s3cr3t"), record, next)).toBeNull();
		expect(ownProxy(at("https://127.0.0.1:47999/s3cr3t"), record, next)).toBeNull();
		// A target without a secret path never matches on the path alone.
		expect(ownProxy(at(oldPort), record, "http://127.0.0.1:48123")).toBeNull();
	});

	it("owns only the exact current secret target and the bare recorded target of the cutover, nothing else", () => {
		const record = { host: HOST, port: 47832, target: TARGET };
		const current = `${TARGET}/s3cr3t`;
		const at = (proxyUrl: string, extra: object = {}) =>
			config({
				TCP: { "47832": { HTTPS: true } },
				Web: { [`${HOST}:47832`]: { Handlers: { "/": { Proxy: proxyUrl }, ...extra } } },
			});
		expect(ownProxy(at(TARGET), record, current)).toBe(TARGET);
		expect(ownProxy(at(current), record, current)).toBe(current);
		expect(handlerIsOurs(at(current), record, current)).toBe(true);
		// The user's own handler on the same local address under another path is not ours.
		expect(ownProxy(at(`${TARGET}/other-app`), record, current)).toBeNull();
		expect(ownProxy(at(`${TARGET}/s3cr3t/more`), record, current)).toBeNull();
		expect(ownProxy(at(`${TARGET}/old-secret`), record, current)).toBeNull();
		// Another local port, or a longer port number that only starts with ours, is not ours.
		expect(ownProxy(at("http://127.0.0.1:51001"), record, current)).toBeNull();
		expect(ownProxy(at("http://127.0.0.1:510000/x"), record, current)).toBeNull();
		expect(ownProxy(at("http://127.0.0.1:3010"), record, current)).toBeNull();
		// A second handler on the port means it is not a single `/` proxy of ours.
		expect(ownProxy(at(TARGET, { "/docs": { Proxy: "http://127.0.0.1:9" } }), record, current)).toBeNull();
		expect(ownProxy(config(userOnly), record, current)).toBeNull();
	});

	it("leaves a handler with an unrelated path on the same address alone when planning a publish", () => {
		const record = { host: HOST, port: 47832, target: TARGET };
		const theirs = config({
			TCP: { "47832": { HTTPS: true } },
			Web: { [`${HOST}:47832`]: proxy(`${TARGET}/other-app`) },
		});
		// Not ours: its port is not reused, the next free one is taken.
		expect(planPublish(theirs, HOST, `${TARGET}/s3cr3t`, record)).toEqual({ kind: "publish", port: 47831 });
	});

	it("gives up when no port in range is free", () => {
		const tcp: Record<string, object> = {};
		for (let port = 47831; port < 47831 + 50; port++) tcp[String(port)] = { HTTPS: true };
		expect(planPublish(config({ TCP: tcp }), HOST, TARGET, null)).toEqual({ kind: "none" });
	});
});
