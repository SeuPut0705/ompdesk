import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";
import { deliveryFor, type MailKind } from "./agent-control/mail";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * A report another session sends while this session runs a turn (`ompdesk_report` progress or note, and the "Closed …"
 * line of a close) shows in its transcript once that turn ends, with no prompt of the person's: main's delivery
 * (`deliveryFor`) through the bridge's `agent_control.mail` on the installed omp, with a scripted OpenAI-compatible
 * provider on loopback (no model spend).
 *
 * Reported on 19 Oct 2026: a parent's progress and close notes stayed out of its transcript for half an hour and then
 * all appeared at once when the person sent a message. Main handed a busy receiver's no-turn report to stock as
 * `deliverAs: "nextTurn"`, which stock keeps hidden (no `message_start`/`message_end`, not journaled) until the next
 * explicit prompt; a turn a done report wakes does not take it either.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const HOLD = "HOLD-MARK run";

type Frame = { type: string; message?: { role?: string; customType?: string; details?: { id?: string } } };

function sse(text: string): string {
	const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m1" };
	const chunks = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		},
	];
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

interface Provider {
	url: string;
	/** Main-agent requests seen (side requests such as a title offer no bash tool and are not counted). */
	turns: number;
	/** Resolves once a request of the held prompt arrived; `release` answers it. */
	held: Promise<void>;
	release(): void;
	close(): Promise<void>;
}

async function startProvider(): Promise<Provider> {
	const arrived = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const provider: Provider = {
		url: "",
		turns: 0,
		held: arrived.promise,
		release: () => released.resolve(),
		close: async () => undefined,
	};
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", async () => {
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
			const main = (parsed.tools ?? []).some(tool => tool.function?.name?.endsWith("bash"));
			if (main) provider.turns++;
			if (main && body.includes(HOLD)) {
				arrived.resolve();
				await released.promise;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(sse(main ? "DONE" : "side"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	provider.url = `http://127.0.0.1:${port}/v1`;
	provider.close = () => {
		released.resolve();
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	};
	return provider;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Omp {
	bridge: GuiBridgeClient;
	frames: Frame[];
	isolated: string;
	send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function startOmp(provider: Provider): Promise<Omp> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-mail-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-mail-repo-")));
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: ${provider.url}`,
			"    apiKey: x",
			"    api: openai-completions",
			"    models:",
			"      - id: m1",
			"        name: m1",
			"        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }",
			"",
		].join("\n"),
	);
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: isolated,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		omp,
		[
			...["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules"],
			...["--model", "fake/m1", "-e", resolve("resources/gui-bridge/index.ts")],
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const frames: Frame[] = [];
	const responses = new Map<string, (value: Record<string, unknown>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame & { id?: string };
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	const bridge = new GuiBridgeClient(address);
	cleanups.push(async () => {
		bridge.close();
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
	});
	await expect.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000 }).toBe(true);
	await expect
		.poll(
			() =>
				bridge.connect(1_000).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, message: `bridge never came up\n${stderr.slice(-2000)}` },
		)
		.toBe(true);
	let counter = 0;
	return {
		bridge,
		frames,
		isolated,
		send: command => {
			const id = `c${++counter}`;
			const { promise, resolve: done, reject: fail } = Promise.withResolvers<Record<string, unknown>>();
			const timer = setTimeout(() => fail(new Error(`no response\n${stderr.slice(-1500)}`)), 60_000);
			responses.set(id, value => {
				clearTimeout(timer);
				done(value);
			});
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			return promise;
		},
	};
}

function journaledMail(isolated: string): string[] {
	const sessions = join(isolated, "agent", "sessions");
	if (!existsSync(sessions)) return [];
	const ids: string[] = [];
	for (const project of readdirSync(sessions)) {
		for (const file of readdirSync(join(sessions, project)).filter(name => name.endsWith(".jsonl"))) {
			for (const line of readFileSync(join(sessions, project, file), "utf8")
				.split("\n")
				.filter(Boolean)) {
				const entry = JSON.parse(line) as { type?: string; customType?: string; details?: { id?: string } };
				if (entry.type === "custom_message" && entry.customType === MAIL_CUSTOM_TYPE && entry.details?.id)
					ids.push(entry.details.id);
			}
		}
	}
	return ids;
}

const shown = (frames: readonly Frame[], id: string) =>
	frames.some(
		frame =>
			frame.type === "message_end" &&
			frame.message?.customType === MAIL_CUSTOM_TYPE &&
			frame.message.details?.id === id,
	);

function mail(kind: MailKind, id: string) {
	return {
		content: `<ompdesk-mail from="child" title="Child" kind="${kind}">\n${id}\n</ompdesk-mail>`,
		details: { id, from: "child", fromTitle: "Child", kind, text: id },
		...deliveryFor(kind),
	};
}

describe.skipIf(!existsSync(omp))("a no-turn report on stock omp", () => {
	it("shows a progress and a note sent during a turn once the turn ends, without a prompt or a model turn", async () => {
		const provider = await startProvider();
		cleanups.push(() => provider.close());
		const session = await startOmp(provider);
		await session.send({ type: "prompt", message: HOLD });
		await provider.held;
		await session.bridge.request("agent_control.mail", mail("progress", "busy-progress"));
		await session.bridge.request("agent_control.mail", mail("note", "busy-note"));
		// Held while the turn runs: neither is in the transcript or the model's context yet; the bridge lists both.
		expect(shown(session.frames, "busy-progress")).toBe(false);
		expect(await session.bridge.request("agent_control.mail_pending", {})).toEqual({
			items: [
				{ id: "busy-progress", from: "Child", kind: "progress" },
				{ id: "busy-note", from: "Child", kind: "note" },
			],
		});
		const turns = provider.turns;
		provider.release();
		await expect.poll(() => session.frames.some(frame => frame.type === "agent_end"), { timeout: 30_000 }).toBe(true);
		await expect.poll(() => shown(session.frames, "busy-progress"), { timeout: 3_000 }).toBe(true);
		await expect.poll(() => shown(session.frames, "busy-note"), { timeout: 3_000 }).toBe(true);
		await expect
			.poll(() => journaledMail(session.isolated), { timeout: 3_000 })
			.toEqual(["busy-progress", "busy-note"]);
		expect(await session.bridge.request("agent_control.mail_pending", {})).toEqual({ items: [] });
		// No turn was started for them.
		expect(provider.turns).toBe(turns);
	}, 180_000);

	it("shows a progress sent to an idle session at once", async () => {
		const provider = await startProvider();
		provider.release();
		cleanups.push(() => provider.close());
		const session = await startOmp(provider);
		// Stock writes the session file with its first reply.
		await session.send({ type: "prompt", message: "first" });
		await expect.poll(() => session.frames.some(frame => frame.type === "agent_end"), { timeout: 30_000 }).toBe(true);
		const turns = provider.turns;
		await session.bridge.request("agent_control.mail", mail("progress", "idle-progress"));
		await expect.poll(() => shown(session.frames, "idle-progress"), { timeout: 3_000 }).toBe(true);
		expect(journaledMail(session.isolated)).toEqual(["idle-progress"]);
		expect(provider.turns).toBe(turns);
	}, 180_000);
});
