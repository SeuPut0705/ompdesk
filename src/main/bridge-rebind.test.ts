/**
 * Stock binds every extension again for each in-process subagent (task executor
 * `preloadedPreparedExtensions` → `bindPreparedExtensions` → the factory), in the same process and
 * module instance. The gui-bridge factory must set up its socket server and the spawn-time defaults
 * once per process: a rebind that replaced the socket would hand main's next reconnect to the
 * subagent's server, and one that re-applied `OMP_GUI_DELEGATION` would silently undo the strength
 * the user picked since. Here a second extension's slash command runs that same stock bind on the
 * session's prepared extensions, the way a subagent's session does.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { RM_TEMP } from "./test-fake-omp";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const omp = path.join(os.homedir(), ".bun/bin/omp");

describe.skipIf(!existsSync(omp) || !existsSync(stockRoot))("gui-bridge bound again for a subagent", () => {
	it("keeps one socket server and the user's delegation strength", async () => {
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bridge-rebind-"));
		const agent = path.join(profile, "agent");
		await fs.mkdir(agent, { mode: 0o700 });
		const wrapper = path.join(profile, "rebind.ts");
		await fs.writeFile(
			wrapper,
			[
				'import { bindPreparedExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";',
				"export default function rebind(pi) {",
				'\tpi.registerCommand("rebind", {',
				"\t\thandler: async () => {",
				"\t\t\tconst session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;",
				'\t\t\tif (!session.preparedExtensions.some(prepared => prepared.path.includes("gui-bridge"))) throw new Error("no gui-bridge to bind");',
				"\t\t\tawait bindPreparedExtensions(session.preparedExtensions, process.cwd());",
				"\t\t},",
				"\t});",
				"}",
			].join("\n"),
		);
		const address = newBridgeAddress();
		const env = {
			...process.env,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: profile,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_BRIDGE: address,
			// omp refuses to start without a usable model; nothing here ever calls one.
			ANTHROPIC_API_KEY: "sk-ant-ompdesk-test",
			OMP_GUI_DELEGATION: "solo",
		};
		const child = spawn(
			omp,
			[
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				path.resolve("resources/gui-bridge/index.ts"),
				"-e",
				wrapper,
			],
			{ cwd: profile, env, stdio: "pipe" },
		);
		let errors = "";
		child.stderr.on("data", chunk => {
			errors += String(chunk);
		});
		const frames = createInterface({ input: child.stdout });
		const exited = (reject: (error: Error) => void) =>
			child.once("exit", code => reject(new Error(`omp exited ${code}: ${errors}`)));
		const response = (id: string) => {
			const { promise, resolve, reject } = Promise.withResolvers<{ success?: boolean; error?: string }>();
			exited(reject);
			frames.on("line", line => {
				const frame = JSON.parse(line) as { type?: string; id?: string; success?: boolean; error?: string };
				if (frame.type === "response" && frame.id === id) resolve(frame);
			});
			return promise;
		};
		const ready = Promise.withResolvers<void>();
		exited(ready.reject);
		frames.on("line", line => {
			if (/"type"\s*:\s*"ready"/.test(line)) ready.resolve();
		});
		const client = new GuiBridgeClient(address);
		const later = new GuiBridgeClient(address);
		try {
			await ready.promise;
			await client.connect();
			expect(await client.request("modes.get_delegation")).toEqual({ mode: "solo" });
			// The user moves the composer chip after the spawn.
			expect(await client.request("modes.set_delegation", { mode: "swarm" })).toEqual({ mode: "swarm" });
			const socketBefore = process.platform === "win32" ? undefined : statSync(address).ino;

			const rebound = response("rebind");
			child.stdin.write(`${JSON.stringify({ id: "rebind", type: "prompt", message: "/rebind" })}\n`);
			expect(await rebound).toMatchObject({ success: true });

			expect(await client.request("modes.get_delegation")).toEqual({ mode: "swarm" });
			if (socketBefore !== undefined) expect(statSync(address).ino).toBe(socketBefore);
			// Main's next reconnect reaches the same server, with the same session state.
			await later.connect();
			expect(await later.request("modes.get_delegation")).toEqual({ mode: "swarm" });
		} finally {
			client.close();
			later.close();
			child.stdin.end();
			if (child.exitCode === null) {
				const gone = Promise.withResolvers<void>();
				child.once("exit", () => gone.resolve());
				await gone.promise;
			}
			removeBridgeAddress(address);
			await fs.rm(profile, RM_TEMP);
		}
	}, 60_000);
});
