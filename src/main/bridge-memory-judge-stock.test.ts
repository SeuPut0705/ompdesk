import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jevJudge, type PagePair } from "./ai-memory/memory-judge";

/**
 * Memory curation's Jev path on the installed omp, no model spend: `memory-judge-host.ts` is loaded the way main loads
 * it (`omp --mode rpc … -e`, an empty folder, stdin held open) and a loopback server stands in for the `typesafe`
 * provider. With a native `judge` role the host's questions go through stock's own `resolveJudge` to
 * `POST /v1/systemone` and the choice comes back as the verdict; with a prompted `judge` role it reports "not
 * available" and not one request leaves. `OMP_GUI_JUDGE_ASSIST=0` (the switch off) is read by stock's engine.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const pair: PagePair = {
	a: {
		path: "decisions/a.md",
		title: "Phones pair with a code",
		kind: "decision",
		saved: "2026-10-18",
		scope: "project",
		text: "Type the pairing code.",
	},
	b: {
		path: "decisions/b.md",
		title: "No pairing code",
		kind: "decision",
		saved: "2026-10-19",
		scope: "project",
		text: "Tailscale identity only.",
	},
};

interface Loopback {
	url: string;
	requests: {
		path: string;
		body: { model?: string; state?: { noteA?: { title?: string } }; questions?: Record<string, { type: string }> };
	}[];
	close(): Promise<void>;
}

async function startLoopback(): Promise<Loopback> {
	const loopback: Loopback = { url: "", requests: [], close: async () => undefined };
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", chunk => {
			raw += chunk;
		});
		req.on("end", () => {
			loopback.requests.push({ path: req.url ?? "", body: JSON.parse(raw || "{}") });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					model: "jev-latest",
					answers: {
						relation: {
							type: "choice",
							choice: "A_outdated",
							probabilities: { A_outdated: 0.97, unrelated: 0.03 },
							confidence: 0.94,
						},
					},
					usage: { input_tokens: 300, output_tokens: 20 },
				}),
			);
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	loopback.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	loopback.close = () => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	};
	return loopback;
}

async function judgeWith(loopback: Loopback, role: "native" | "prompted", enabled = true) {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-mj-"));
	chmodSync(isolated, 0o700);
	const saved = { ...process.env };
	try {
		const cost = "{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }";
		const providers = [
			"  fake:",
			`    baseUrl: ${loopback.url}/v1`,
			"    apiKey: x",
			"    api: openai-completions",
			"    models:",
			"      - id: m1",
			"        name: m1",
			`        cost: ${cost}`,
			...(role === "native"
				? [
						"  jev:",
						`    baseUrl: ${loopback.url}`,
						"    apiKey: x",
						"    api: typesafe",
						"    models:",
						"      - id: jev-latest",
						"        name: jev-latest",
						"        input: [text]",
						`        cost: ${cost}`,
					]
				: []),
		];
		writeFileSync(join(isolated, "models.yml"), ["providers:", ...providers, ""].join("\n"));
		writeFileSync(
			join(isolated, "config.yml"),
			`modelRoles:\n  judge: ${role === "native" ? "jev/jev-latest" : "fake/m1"}\n  default: fake/m1\n`,
		);
		const cwd = join(isolated, "empty");
		mkdirSync(cwd, { recursive: true });
		Object.assign(process.env, {
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
		});
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"OPENAI_API_KEY",
			"OPENROUTER_API_KEY",
			"TYPESAFE_API_KEY",
			"TYPESAFE_BASE_URL",
		])
			Reflect.deleteProperty(process.env, key);
		return await jevJudge({
			omp: { bin: omp },
			hostFile: resolve("resources/gui-bridge/memory-judge-host.ts"),
			enabled: () => enabled,
			cwd,
		})([pair], "");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) Reflect.deleteProperty(process.env, key);
		Object.assign(process.env, saved);
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("memory curation's judge host on stock omp", () => {
	it("asks stock's native judge for each pair and returns the choice as the verdict", async () => {
		const loopback = await startLoopback();
		try {
			const judgment = await judgeWith(loopback, "native");
			expect(judgment?.by).toBe("jev");
			expect(judgment?.verdicts[0]).toEqual({ relation: "a_outdated", confidence: 0.97 });
			expect(loopback.requests.map(request => request.path)).toEqual(["/v1/systemone"]);
			const sent = loopback.requests[0]?.body;
			expect(sent?.model).toBe("jev-latest");
			expect(sent?.state?.noteA?.title).toBe("Phones pair with a code");
			expect(sent?.questions?.relation?.type).toBe("choice");
		} finally {
			await loopback.close();
		}
	}, 130_000);

	it("with no native judge nothing is asked, of Jev or of any chat model", async () => {
		const loopback = await startLoopback();
		try {
			expect(await judgeWith(loopback, "prompted")).toBeNull();
			expect(loopback.requests).toEqual([]);
		} finally {
			await loopback.close();
		}
	}, 130_000);

	it("with the judge switch off in the app, main never starts the host", async () => {
		const loopback = await startLoopback();
		try {
			expect(await judgeWith(loopback, "native", false)).toBeNull();
			expect(loopback.requests).toEqual([]);
		} finally {
			await loopback.close();
		}
	}, 130_000);
});
