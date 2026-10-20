// Loaded by main's memory curation with `omp --mode rpc --no-session --no-extensions --no-skills --no-rules -e <this>`
// in an empty folder (`src/main/ai-memory/memory-judge.ts`). It asks stock's own judge chain (the `judge` role: the
// native Jev only while `hasNativeJudge` says so, through judge-assist-engine's gate, cache and usage ledger) the
// requests in $OMP_GUI_MEMORY_JUDGE_IN, writes the answers to $OMP_GUI_MEMORY_JUDGE_OUT and exits. It never falls
// back to a chat model: without a native judge `available` is false and nothing was asked.
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import "./modes/judge-assist";
import { askJudge, type JudgeSession, judgeAvailable } from "./modes/judge-assist-engine";

interface HostInput {
	requests: { id: string; request: unknown }[];
	/** One judgment waits this long (a cold first call outlasts the interactive 2 s). */
	timeoutMs: number;
	/** Judgments in flight at once after the first. */
	concurrency: number;
}

interface UsageEntry {
	type: string;
	purpose?: string;
	model?: string;
	usage?: unknown;
}

interface HostSession extends JudgeSession {
	readonly sessionManager: { getEntries(): UsageEntry[] };
}

interface Registry {
	AgentRegistry: { global(): { get(id: string): { session: HostSession } } };
	MAIN_AGENT_ID: string;
}

const PURPOSE = "ompdesk-memory-curate";

export default function (pi: ExtensionAPI & { pi: Registry }) {
	// The judgments outlast stock's 30 s extension-handler limit, so they run after the handler returns.
	pi.on("session_start", () => {
		setTimeout(() => void run(pi), 0);
	});
}

async function run(pi: ExtensionAPI & { pi: Registry }): Promise<void> {
	const out: Record<string, unknown> = { available: false };
	try {
		const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
		const input = JSON.parse(fs.readFileSync(process.env.OMP_GUI_MEMORY_JUDGE_IN ?? "", "utf8")) as HostInput;
		out.available = await judgeAvailable(session);
		if (out.available) {
			const results: { id: string; answers: unknown; ms: number }[] = [];
			const ask = async (entry: HostInput["requests"][number]) => {
				const started = performance.now();
				const answers = (await askJudge(session, PURPOSE, () => entry.request, input.timeoutMs)) ?? null;
				results.push({ id: entry.id, answers, ms: Math.round(performance.now() - started) });
			};
			// The first call alone: an aborted cold call leaves the ones behind it cold too.
			const [first, ...rest] = input.requests;
			if (first) await ask(first);
			let next = 0;
			await Promise.all(
				Array.from({ length: Math.max(1, input.concurrency) }, async () => {
					for (let entry = rest[next++]; entry; entry = rest[next++]) await ask(entry);
				}),
			);
			out.results = results;
			out.usage = session.sessionManager
				.getEntries()
				.filter(entry => entry.type === "model_usage" && entry.purpose === PURPOSE)
				.map(entry => ({ model: entry.model, usage: entry.usage }));
		}
	} catch (error) {
		out.error = String(error instanceof Error ? error.stack : error);
	}
	const target = process.env.OMP_GUI_MEMORY_JUDGE_OUT ?? "";
	fs.writeFileSync(`${target}.part`, JSON.stringify(out));
	fs.renameSync(`${target}.part`, target);
	process.exit(0);
}
