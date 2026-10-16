/**
 * The channel policy against what really crosses: the handlers main registers (`ipc.handle` / `ipc.on`
 * in src/main, read from the source) and the push channels `createOmpApi` subscribes to.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import { createOmpApi } from "../../shared/omp-api";
import * as preview from "../../shared/preview";
import * as schedules from "../../shared/schedules";
import * as sshTools from "../../shared/ssh-tools";
import { IPC_POLICY, type IpcChannel } from "./ipc-policy";

const MAIN = path.join(__dirname, "..");
const NAMED: Record<string, unknown> = { ...preview, ...schedules, ...sshTools };
const GROUPS: Record<string, Record<string, string>> = { IPC_COMMANDS, IPC_EVENTS };

/** The channel a registration's first argument names: `IPC_COMMANDS.X`, a shared constant, or a literal. */
function channelOf(expression: string): string {
	const literal = /^"([^"]+)"$/.exec(expression);
	if (literal?.[1]) return literal[1];
	const [group, key] = expression.split(".");
	const value = key && group ? GROUPS[group]?.[key] : NAMED[expression];
	if (typeof value !== "string") throw new Error(`Unresolved channel expression: ${expression}`);
	return value;
}

/** Every `ipc.handle(…)` / `ipc.on(…)` channel in main's sources, by direction. */
function registeredChannels(): { invoke: string[]; send: string[] } {
	const invoke: string[] = [];
	const send: string[] = [];
	const files = fs.readdirSync(MAIN, { recursive: true, encoding: "utf8" });
	for (const file of files) {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith("ipc-registry.ts")) continue;
		const source = fs.readFileSync(path.join(MAIN, file), "utf8");
		for (const match of source.matchAll(/\bipc\.(handle|on)\(\s*([^,\s]+)\s*,/g)) {
			const [, method, expression] = match;
			if (!expression) continue;
			(method === "handle" ? invoke : send).push(channelOf(expression));
		}
	}
	return { invoke: invoke.sort(), send: send.sort() };
}

function policyChannels(dir: "invoke" | "send" | "push"): string[] {
	return Object.entries(IPC_POLICY)
		.filter(([, policy]) => policy.dir === dir)
		.map(([channel]) => channel)
		.sort();
}

/** The push channels the renderer API subscribes to: every `on…` function, called once. */
function subscribedChannels(): string[] {
	const channels: string[] = [];
	const api = createOmpApi({
		invoke: async () => undefined as never,
		send: () => {},
		on: channel => {
			channels.push(channel);
			return () => {};
		},
	});
	const visit = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		for (const [name, value] of Object.entries(node)) {
			if (typeof value === "function" && /^on[A-Z]/.test(name)) value(() => {});
			else visit(value);
		}
	};
	visit(api);
	return [...new Set(channels)].sort();
}

describe("IPC channel policy", () => {
	it("classifies exactly the invoke and send channels main registers, each once", () => {
		const { invoke, send } = registeredChannels();
		expect(new Set(invoke).size).toBe(invoke.length);
		expect(new Set(send).size).toBe(send.length);
		expect(invoke).toEqual(policyChannels("invoke"));
		expect(send).toEqual(policyChannels("send"));
	});

	it("classifies exactly the push channels the renderer API listens to", () => {
		expect(subscribedChannels()).toEqual(policyChannels("push"));
	});

	it("refuses only the pairing boundary, and grants pairing-admin nowhere else", () => {
		const boundary = Object.entries(IPC_POLICY).filter(([, policy]) => policy.mode === "boundary");
		expect(boundary.map(([channel]) => channel)).toEqual([IPC_COMMANDS.REMOTE_ROTATE_CODE]);
		const pairing = Object.entries(IPC_POLICY).filter(
			([, policy]) => policy.dir !== "push" && policy.permission === "pairing-admin",
		);
		expect(pairing.map(([channel]) => channel)).toEqual([IPC_COMMANDS.REMOTE_ROTATE_CODE]);
	});

	it("says what the web side does for every channel it does not pass through", () => {
		for (const [channel, policy] of Object.entries(IPC_POLICY) as [IpcChannel, (typeof IPC_POLICY)[IpcChannel]][]) {
			if (policy.mode === "pass" || policy.mode === "boundary") continue;
			expect(policy.web.trim(), channel).not.toBe("");
		}
	});
});
