import { describe, expect, it } from "vitest";
import {
	funnelOn,
	handlerIsOurs,
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
		expect(handlerIsOurs(ours, record)).toBe(true);
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47831`]: proxy("http://127.0.0.1:1") } }), record)).toBe(false);
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47832`]: proxy(TARGET) } }), record)).toBe(false);
		expect(handlerIsOurs(config({}), record)).toBe(false);
		const extra = { Handlers: { "/": { Proxy: TARGET }, "/x": { Proxy: TARGET } } };
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47831`]: extra } }), record)).toBe(false);
		const path = { Handlers: { "/": { Path: "/tmp", Proxy: TARGET } } };
		expect(handlerIsOurs(config({ Web: { [`${HOST}:47831`]: path } }), record)).toBe(false);
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

	it("gives up when no port in range is free", () => {
		const tcp: Record<string, object> = {};
		for (let port = 47831; port < 47831 + 50; port++) tcp[String(port)] = { HTTPS: true };
		expect(planPublish(config({ TCP: tcp }), HOST, TARGET, null)).toEqual({ kind: "none" });
	});
});
