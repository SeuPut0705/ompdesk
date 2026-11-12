/**
 * Captures what the TypeScript `PeerStore` and `HostStore` do (value returned and the file's exact bytes and mode
 * after each step) for `crates/core/src/remote/store.rs`'s tests: `OMPDESK_STORE_CAPTURE=write bunx vitest run
 * --project=node src/main/remote/store-capture.test.ts`. Without the flag it does nothing.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { HostStore } from "./hosts-store";
import { PeerStore } from "./peers-store";

type Kind = "peers" | "hosts";
type Fields = Record<string, unknown>;
type Op =
	| ["write", string]
	| ["writeHex", string]
	| ["fresh"]
	| ["list"]
	| ["get", string]
	| ["put", Fields]
	| ["update", string, Fields]
	| ["remove", string]
	| ["byNode", string]
	| ["remember", string, string];

interface Store {
	list(): unknown[];
	get(id: string): unknown;
	put(entry: never): void;
	update(id: string, patch: never): unknown;
	remove(id: string): boolean;
	byNode(node: string): unknown;
	rememberAddress?(id: string, address: string): unknown;
}

const key = (c: string, n = 43) => c.repeat(n);
const K = key("A");
const K2 = `${"b-_".repeat(14)}b`;

/** `undefined` cannot cross JSON: a top-level undefined is the marker the core's methods read as undefined. */
const marker = { "~undefined": true };
const encode = (fields: Fields): Fields =>
	Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v === undefined ? marker : v]));
/** What a reader of the JSON sees: undefined keys gone, undefined itself null. */
const plain = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

const peer = (id: string, extra: Fields = {}): Fields => ({
	deviceId: id,
	name: `Phone ${id}`,
	staticPub: K,
	nodeId: `node-${id}`,
	login: "a@b.c",
	pairedAt: 1700000000000,
	...extra,
});
const host = (id: string, extra: Fields = {}): Fields => ({
	deviceId: id,
	name: `Mac ${id}`,
	staticPub: K2,
	nodeId: `node-${id}`,
	addresses: ["100.64.0.1:7777", "100.64.0.1:7778"],
	pairedAt: 1700000000000,
	...extra,
});
const base = (kind: Kind, id: string, extra: Fields = {}) => (kind === "peers" ? peer(id, extra) : host(id, extra));

interface Scenario {
	name: string;
	kind: Kind;
	steps: Record<string, unknown>[];
}

function run(name: string, kind: Kind, ops: Op[]): Scenario {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-store-capture-"));
	const file = join(dir, kind === "peers" ? "remote-peers.json" : "remote-hosts.json");
	const open = (): Store => (kind === "peers" ? new PeerStore(dir) : new HostStore(dir)) as unknown as Store;
	let store = open();
	const steps: Record<string, unknown>[] = [];
	const after = (step: Record<string, unknown>): Record<string, unknown> => {
		step.file = existsSync(file) ? readFileSync(file, "utf8") : null;
		step.mode = existsSync(file) ? statSync(file).mode & 0o777 : null;
		return step;
	};
	try {
		for (const op of ops) {
			switch (op[0]) {
				case "write":
					writeFileSync(file, op[1]);
					chmodSync(file, 0o644);
					steps.push({ op: "write", text: op[1] });
					break;
				case "writeHex":
					writeFileSync(file, Buffer.from(op[1], "hex"));
					chmodSync(file, 0o644);
					steps.push({ op: "write", hex: op[1] });
					break;
				case "fresh":
					store = open();
					steps.push({ op: "fresh" });
					break;
				case "list":
					steps.push({ op: "list", result: plain(store.list()) });
					break;
				case "get":
					steps.push({ op: "get", id: op[1], result: plain(store.get(op[1])) });
					break;
				case "byNode":
					steps.push({ op: "byNode", node: op[1], result: plain(store.byNode(op[1])) });
					break;
				case "put": {
					let result = "ok";
					try {
						store.put(op[1] as never);
					} catch {
						result = "throws";
					}
					steps.push(after({ op: "put", entry: encode(op[1]), result }));
					break;
				}
				case "update": {
					const result = plain(store.update(op[1], op[2] as never));
					steps.push(after({ op: "update", id: op[1], patch: encode(op[2]), result }));
					break;
				}
				case "remove": {
					const result = store.remove(op[1]);
					steps.push(after({ op: "remove", id: op[1], result }));
					break;
				}
				case "remember": {
					const result = plain(store.rememberAddress?.(op[1], op[2]));
					steps.push(after({ op: "remember", id: op[1], address: op[2], result }));
					break;
				}
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return { name, kind, steps };
}

/** A file's text with the entries as given raw JSON text (`[key, raw]` pairs; raw null leaves the key out). */
const entryText = (fields: [string, string | null][]) =>
	`{${fields
		.filter(([, raw]) => raw !== null)
		.map(([k, raw]) => `${JSON.stringify(k)}:${raw}`)
		.join(",")}}`;
const fileText = (kind: Kind, entries: string[], head = '"v":1') => `{${head},"${kind}":[${entries.join(",")}]}\n`;

const peerFields = (): [string, string | null][] => [
	["deviceId", '"p1"'],
	["name", '"Phone"'],
	["staticPub", JSON.stringify(K)],
	["nodeId", '"n1"'],
	["login", '"a@b.c"'],
	["pairedAt", "1700000000000"],
];
const hostFields = (): [string, string | null][] => [
	["deviceId", '"h1"'],
	["name", '"Mac"'],
	["staticPub", JSON.stringify(K2)],
	["nodeId", '"n1"'],
	["addresses", '["100.64.0.1:7777"]'],
	["pairedAt", "1700000000000"],
];

/** Every load case: write the text, load fresh, read, add one entry (the save shows the normalised form), reload. */
function loadCase(name: string, kind: Kind, text: string, hex = false): Scenario {
	const second = base(kind, "second");
	return run(`load ${kind}: ${name}`, kind, [
		hex ? ["writeHex", text] : ["write", text],
		["fresh"],
		["list"],
		["put", second],
		["fresh"],
		["list"],
	]);
}

/** One entry's field replaced (raw JSON text) or removed (null), or an extra field appended. */
function variant(kind: Kind, field: string, raw: string | null): string {
	const fields = kind === "peers" ? peerFields() : hostFields();
	const at = fields.findIndex(([k]) => k === field);
	if (at >= 0) fields[at] = [field, raw];
	else fields.push([field, raw]);
	return fileText(kind, [entryText(fields)]);
}

it("captures", () => {
	if (process.env.OMPDESK_STORE_CAPTURE !== "write") return;
	const scenarios: Scenario[] = [];

	for (const kind of ["peers", "hosts"] as const) {
		const plainFields = kind === "peers" ? peerFields() : hostFields();
		const good = entryText(plainFields);
		const second = entryText(plainFields.map(([k, raw]) => (k === "deviceId" ? [k, '"p2"'] : [k, raw])));

		// the file as a whole
		scenarios.push(
			run(`missing file ${kind}`, kind, [
				["list"],
				["get", "p1"],
				["byNode", "n1"],
				["remove", "p1"],
				["update", "p1", { name: "x" }],
			]),
		);
		const files: [string, string][] = [
			["empty", ""],
			["not json", "not json"],
			["truncated", `{"v":1,"${kind}":[`],
			["bom", `\ufeff${fileText(kind, [good])}`],
			["whitespace around", `  \n${fileText(kind, [good])}\n `],
			["pretty tabs", `{\n\t"v": 1,\n\t"${kind}": [\n\t\t${good}\n\t]\n}\n`],
			["v 2", fileText(kind, [good], '"v":2')],
			["v string", fileText(kind, [good], '"v":"1"')],
			["v 1.0", fileText(kind, [good], '"v":1.0')],
			["v 1e0", fileText(kind, [good], '"v":1e0')],
			["v true", fileText(kind, [good], '"v":true')],
			["v null", fileText(kind, [good], '"v":null')],
			["v absent", `{"${kind}":[${good}]}`],
			["v last", `{"${kind}":[${good}],"v":1}`],
			["v twice, last wins", `{"v":2,"${kind}":[${good}],"v":1}`],
			["top-level array", `[${good}]`],
			["top-level null", "null"],
			["top-level string", '"x"'],
			["top-level number", "1"],
			["key absent", '{"v":1}'],
			["key null", `{"v":1,"${kind}":null}`],
			["key object", `{"v":1,"${kind}":{"0":${good}}}`],
			["key string", `{"v":1,"${kind}":"x"}`],
			["other kind's key", `{"v":1,"${kind === "peers" ? "hosts" : "peers"}":[${good}]}`],
			["key twice, last wins", `{"v":1,"${kind}":[${good}],"${kind}":[]}`],
			["extra top-level keys", `{"v":1,"extra":5,"${kind}":[${good}]}`],
			["empty list", fileText(kind, [])],
			["valid, invalid, valid", fileText(kind, [good, "5", second])],
			[
				"duplicate ids keep the first place and the last value",
				fileText(kind, [
					good,
					second,
					entryText(plainFields.map(([k, raw]) => (k === "name" ? [k, '"Again"'] : [k, raw]))),
				]),
			],
			["entry not an object: null", fileText(kind, ["null"])],
			["entry not an object: number", fileText(kind, ["5"])],
			["entry not an object: string", fileText(kind, ['"x"'])],
			["entry not an object: array", fileText(kind, [`[${good}]`])],
			["entry not an object: true", fileText(kind, ["true"])],
			["entry order scrambled", fileText(kind, [entryText([...plainFields].reverse())])],
			[
				"unknown keys stripped",
				fileText(kind, [entryText([...plainFields, ["extra", '{"a":1}'], ["limitz", "5"]])]),
			],
			["a proto key", fileText(kind, [entryText([["__proto__", '{"deviceId":"x"}'], ...plainFields])])],
			[
				"name with escapes",
				variant(kind, "name", '"q\\"b\\\\s\\/ \\u0001\\u007f\\u2028\\ud83d\\ude00 \\n\\t\\b\\f\\r é"'),
			],
			["name raw non-ascii", variant(kind, "name", '"日本語 \u2028 \u00e9"')],
			["name empty", variant(kind, "name", '""')],
		];
		for (const [name, content] of files) scenarios.push(loadCase(name, kind, content));
		scenarios.push(
			loadCase(
				"invalid utf-8 in the name",
				kind,
				Buffer.from(variant(kind, "name", '"a\u0001z"'))
					.toString("hex")
					.replace("01", "ff"),
				true,
			),
		);

		// one field at a time
		const fields: Record<string, (string | null)[]> = {
			deviceId: ['""', "5", "null", null, '"a b"', '"x"'],
			name: [null, "5", "null", '"n"'],
			staticPub: [
				'"short"',
				JSON.stringify(key("A", 44)),
				JSON.stringify(`${key("A", 42)}+`),
				JSON.stringify(`${key("A", 42)}\n`),
				JSON.stringify(`${key("A", 42)}é`),
				"null",
				null,
				JSON.stringify(`${"-_".repeat(21)}9`),
			],
			nodeId: ['""', "null", null, "5", '"x"', '" "'],
			pairedAt: [
				'"1700"',
				null,
				"null",
				"1.5",
				"1e21",
				"1E+21",
				"1e+21",
				"12345678901234567890",
				"-0",
				"1e-7",
				"0.000001",
				"0.0000015",
				"9007199254740993",
				"-5",
				"1e3",
				"0.1",
				"123456789.123456789",
				"true",
				"1.0",
				"5e-324",
				"1.7976931348623157e308",
				"100000000000000000000",
				"1e20",
				"4.5e-7",
				"1e300",
				"0",
				"1700000000000.5",
				"2.5e5",
				"123e-2",
				"9007199254740991",
				"1.2345678901234567e19",
				"0.1e1",
			],
		};
		if (kind === "peers") {
			Object.assign(fields, {
				login: [null, "null", "5", '""', '"x"'],
				lastSeenAt: ["null", '"x"', "5", "1.5", "1e21", "-1", "1700000000001", "true"],
				limits: [
					"{}",
					'{"requestsPerDay":-1}',
					'{"requestsPerDay":1.5}',
					'{"requestsPerDay":5,"tokensPerDay":1e3}',
					"null",
					"[]",
					'{"tokensPerDay":2,"requestsPerDay":1,"extra":1}',
					'{"requestsPerDay":null}',
					'{"requestsPerDay":2.0}',
					'{"requestsPerDay":"5"}',
					"5",
					'{"tokensPerDay":0}',
					'{"requestsPerDay":-0}',
					'{"requestsPerDay":1e21}',
					'{"tokensPerDay":7}',
					'{"extra":1}',
				],
				usage: [
					'{"day":"2026-11-12"}',
					'{"day":"d","requests":3,"tokens":9}',
					'{"tokens":9,"extra":true,"requests":3,"day":"d"}',
					'{"day":"d","requests":-1,"tokens":0}',
					"null",
					'{"day":5,"requests":1,"tokens":1}',
					'{"day":"d","requests":1.5,"tokens":1}',
					"[]",
					"{}",
					'{"day":"d","requests":1,"tokens":null}',
					'{"day":"","requests":0,"tokens":0}',
					'{"day":"d","requests":1e3,"tokens":2.0}',
				],
			});
		} else {
			Object.assign(fields, {
				addresses: [
					null,
					"null",
					'"x"',
					"[]",
					'["a",5]',
					'["a",null]',
					'["a","a"]',
					'{"0":"a"}',
					JSON.stringify(Array.from({ length: 11 }, (_, i) => `100.64.0.${i}:7777`)),
					'["é\\n"]',
				],
			});
		}
		for (const [field, raws] of Object.entries(fields)) {
			for (const raw of raws)
				scenarios.push(loadCase(`${field} = ${raw ?? "(absent)"}`, kind, variant(kind, field, raw)));
		}
	}

	const P = "peers" as const;
	const H = "hosts" as const;
	const many = (n: number) => Array.from({ length: n }, (_, i) => `100.64.0.${i + 1}:7777`);

	scenarios.push(
		run("put new, replace keeps the place", P, [
			["put", peer("a")],
			["put", peer("b")],
			["put", peer("c")],
			["put", { name: "A2", deviceId: "a", pairedAt: 5, staticPub: K2, login: null, nodeId: null }],
			["list"],
			["get", "a"],
			["get", "zz"],
			["fresh"],
			["list"],
		]),
		run("put keeps the caller's key order and extras until reload", P, [
			[
				"put",
				{
					pairedAt: 1,
					deviceId: "a",
					extra: { x: [1, { y: null }], z: [], w: {} },
					name: "N",
					staticPub: K,
					login: null,
					nodeId: null,
				},
			],
			["list"],
			["fresh"],
			["list"],
		]),
		run("put with undefined values", P, [
			["put", peer("a", { limits: undefined, lastSeenAt: undefined, nodeId: undefined })],
			["list"],
			["get", "a"],
			["fresh"],
			["list"],
			["put", peer("b")],
			["fresh"],
			["list"],
		]),
		run("put on a file with mode 0644 pins 0600", P, [
			["write", fileText(P, [])],
			["put", peer("a")],
			["remove", "a"],
		]),
		run("put numbers", P, [
			["put", peer("a", { pairedAt: 1.5 })],
			["put", peer("b", { pairedAt: 1e21 })],
			["put", peer("c", { pairedAt: 1e-7 })],
			["put", peer("d", { pairedAt: 0.000001 })],
			["put", peer("e", { pairedAt: -0 })],
			["put", peer("f", { pairedAt: 2 ** 53 + 2 })],
			["put", peer("g", { pairedAt: 1e300 })],
			["put", peer("h", { pairedAt: 123456789.12345679 })],
			["put", peer("i", { pairedAt: 5e-324 })],
			["put", peer("j", { pairedAt: 1.7976931348623157e308 })],
			["put", peer("k", { pairedAt: 1e20 })],
			["put", peer("l", { pairedAt: 4.5e-7 })],
			["put", peer("m", { pairedAt: -1.25e-9, lastSeenAt: 1e21, limits: { requestsPerDay: 1e21 } })],
			["list"],
			["fresh"],
			["list"],
		]),
		run("put strings", P, [
			["put", peer("a", { name: 'q"b\\s/ \u0001\u001f\u007f\u2028\u2029 \u{1f600} \n\t\b\f\r é 日本語' })],
			["put", peer('b\n"', { name: "" })],
			["put", peer("é", { name: "\u0000" })],
			["list"],
			["fresh"],
			["list"],
			["get", "é"],
			["get", 'b\n"'],
		]),
		run("put nested values as given", P, [
			[
				"put",
				peer("a", {
					limits: { tokensPerDay: 1, requestsPerDay: 2 },
					usage: { tokens: 1, day: "d", requests: 2 },
					deep: [[], [[]], {}, [{}], { a: { b: { c: [1, 2, [3]] } } }, null, true, false, "s", 0.5],
				}),
			],
			["fresh"],
			["list"],
		]),
		run("update appends a new key, keeps an existing key's place", P, [
			["put", peer("a")],
			["put", peer("b")],
			["update", "a", { lastSeenAt: 5 }],
			["update", "a", { name: "A2" }],
			["update", "a", { usage: { day: "d", requests: 1, tokens: 2 } }],
			["update", "a", { lastSeenAt: 6, limits: { requestsPerDay: 1 } }],
			["update", "a", {}],
			["update", "b", { name: "B2", nodeId: null }],
			["update", "zz", { name: "x" }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("update with undefined keeps a place for a later set", P, [
			["put", peer("a")],
			["update", "a", { limits: undefined }],
			["update", "a", { usage: { day: "d", requests: 1, tokens: 1 } }],
			["update", "a", { limits: { requestsPerDay: 3 } }],
			["update", "a", { lastSeenAt: 9 }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("update with undefined removes a key from the file", P, [
			["put", peer("a", { lastSeenAt: 4, limits: { requestsPerDay: 1 } })],
			["update", "a", { lastSeenAt: undefined }],
			["update", "a", { limits: undefined, name: "N" }],
			["list"],
			["get", "a"],
			["fresh"],
			["list"],
			["update", "a", { nodeId: undefined, login: undefined }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("update on a loaded entry", P, [
			["write", fileText(P, [entryText(peerFields())])],
			["fresh"],
			["update", "p1", { limits: undefined }],
			["update", "p1", { lastSeenAt: 1 }],
			["update", "p1", { limits: { tokensPerDay: 1 } }],
			["fresh"],
			["list"],
		]),
		run("update with a deviceId in the patch", P, [
			["put", peer("a")],
			["put", peer("b")],
			["update", "a", { deviceId: "x" }],
			["list"],
			["get", "a"],
			["get", "x"],
			["remove", "x"],
			["remove", "a"],
			["fresh"],
			["list"],
		]),
		run("remove present and absent", P, [
			["put", peer("a")],
			["put", peer("b")],
			["put", peer("c")],
			["remove", "b"],
			["remove", "b"],
			["remove", "zz"],
			["list"],
			["fresh"],
			["list"],
			["remove", "a"],
			["remove", "c"],
			["list"],
			["put", peer("d")],
			["list"],
		]),
		run("remove without a file writes nothing", P, [["remove", "a"], ["list"]]),
		run("byNode", P, [
			["put", peer("a", { nodeId: "n1" })],
			["put", peer("b", { nodeId: null })],
			["put", peer("c", { nodeId: "n1" })],
			["put", peer("d", { nodeId: "" })],
			["put", peer("e", { nodeId: undefined })],
			["byNode", "n1"],
			["byNode", "n2"],
			["byNode", ""],
			["byNode", "node-zz"],
			["fresh"],
			["byNode", "n1"],
			["byNode", "n2"],
		]),
		run("put replaces a peer's usage and drops it", P, [
			["put", peer("a", { usage: { day: "d", requests: 1, tokens: 2 }, limits: { requestsPerDay: 5 } })],
			["put", peer("a")],
			["list"],
			["fresh"],
			["list"],
		]),
		run("put into a missing folder", P, [["put", peer("a")], ["list"]]),

		run("hosts: put keeps every address, update cuts to eight", H, [
			["put", host("a", { addresses: many(10) })],
			["list"],
			["fresh"],
			["list"],
			["update", "a", { name: "A2" }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: update addresses", H, [
			["put", host("a")],
			["put", host("b")],
			["update", "a", { addresses: many(12) }],
			["update", "a", { addresses: [] }],
			["update", "a", { addresses: ["x:1"] }],
			["update", "b", { addresses: undefined }],
			["update", "b", { addresses: null }],
			["update", "b", { addresses: many(8) }],
			["update", "zz", { addresses: ["x"] }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: update with undefined and new keys", H, [
			["put", host("a")],
			["update", "a", { nodeId: undefined }],
			["list"],
			["fresh"],
			["list"],
			["update", "a", { extra: 1 }],
			["update", "a", { extra: undefined, name: "N" }],
			["update", "a", { nodeId: "n" }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: put in a different key order", H, [
			["put", { addresses: ["a:1"], pairedAt: 3, name: "N", deviceId: "a", staticPub: K2, nodeId: null }],
			["list"],
			["fresh"],
			["list"],
			["update", "a", { name: "M" }],
		]),
		run("hosts: put without addresses throws and changes nothing", H, [
			["put", host("a")],
			["put", { deviceId: "b", name: "n", staticPub: K2, nodeId: null, pairedAt: 1 }],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: rememberAddress", H, [
			["put", host("a", { addresses: ["a:1", "a:2", "a:3"] })],
			["put", host("b", { addresses: [] })],
			["remember", "a", "a:1"],
			["remember", "a", "a:3"],
			["remember", "a", "a:9"],
			["remember", "a", "a:3"],
			["remember", "zz", "a:1"],
			["remember", "b", "b:1"],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: rememberAddress to the front keeps eight", H, [
			["put", host("a", { addresses: many(8) })],
			["remember", "a", "100.64.0.8:7777"],
			["remember", "a", "100.64.0.5:7777"],
			["remember", "a", "new:1"],
			["list"],
			["put", host("b", { addresses: many(10) })],
			["remember", "b", "100.64.0.1:7777"],
			["remember", "b", "100.64.0.10:7777"],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: rememberAddress on a loaded host that already leads writes nothing", H, [
			["write", fileText(H, [entryText(hostFields())])],
			["fresh"],
			["remember", "h1", "100.64.0.1:7777"],
			["remember", "h1", "100.64.0.1:7778"],
			["list"],
			["fresh"],
			["list"],
		]),
		run("hosts: rememberAddress repeated address in the list", H, [
			["put", host("a", { addresses: ["a:1", "a:2", "a:2", "a:3"] })],
			["remember", "a", "a:2"],
			["list"],
		]),
		run("hosts: byNode", H, [
			["put", host("a", { nodeId: "n1" })],
			["put", host("b", { nodeId: null })],
			["put", host("c", { nodeId: "n1" })],
			["byNode", "n1"],
			["byNode", "n2"],
			["byNode", ""],
			["fresh"],
			["byNode", "n1"],
			["get", "c"],
			["get", "zz"],
		]),
		run("hosts: remove", H, [
			["put", host("a")],
			["put", host("b")],
			["remove", "a"],
			["remove", "a"],
			["list"],
			["fresh"],
			["list"],
			["remove", "b"],
			["list"],
		]),
		run("hosts: float and large numbers", H, [
			["put", host("a", { pairedAt: 1e21 })],
			["put", host("b", { pairedAt: 1.5e-7 })],
			["put", host("c", { pairedAt: 0.000001 })],
			["put", host("d", { pairedAt: 2 ** 53 + 2 })],
			["list"],
			["fresh"],
			["list"],
		]),
	);

	const rows = scenarios.reduce((n, s) => n + s.steps.length, 0);
	writeFileSync(
		"native/ompdesk/crates/core/src/remote/store-captured.json",
		`${JSON.stringify({ scenarios }, null, 1)}\n`,
	);
	console.log(`store capture: ${scenarios.length} scenarios, ${rows} steps`);
});
