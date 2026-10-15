import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in audit on the user's small model: stock's own continue path really resumes
// a turn that was killed mid-run. A long `bash` call is cut off by SIGKILL (no quit hook, no
// exit record); the next launch on the same userData finds the marker, the bridge runs stock
// `restoreSession` (what `omp --restore` runs) and the turn finishes with its reply.
interface SessionLine {
	type?: string;
	message?: { role?: string; stopReason?: string; content?: unknown };
}

/** Every `.jsonl` under the agent dir's sessions, parsed. */
function sessionLines(agent: string): SessionLine[] {
	const lines: SessionLine[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) {
				for (const line of readFileSync(full, "utf8").split("\n")) {
					if (line) lines.push(JSON.parse(line) as SessionLine);
				}
			}
		}
	};
	try {
		walk(path.join(agent, "sessions"));
	} catch {
		return [];
	}
	return lines;
}

function assistantText(line: SessionLine): string {
	const content = line.message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
		.join("");
}

test("real omp: a turn killed mid-run continues on the next launch through stock restoreSession", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(900_000);
	const { profile, desktop, agent, env, project } = await realOmpProfile();
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			lastProject: project,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
		}),
	);
	const args = [path.resolve("out/main/index.js"), `--user-data-dir=${desktop}`];
	let current: Awaited<ReturnType<typeof electron.launch>> | undefined;
	try {
		const first = await electron.launch({ args, env });
		current = first;
		const page = await first.firstWindow();
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const input = page.locator("textarea").first();
		await input.fill(
			"Run the bash command `sleep 40` and wait for it. When it finishes, reply with exactly the word FINISHED-RESUME.",
		);
		await input.press("Enter");

		// The call is on disk, so the cut-off turn has a tool batch to run again.
		await expect
			.poll(
				() =>
					sessionLines(agent).some(
						line =>
							line.message?.role === "assistant" && JSON.stringify(line.message.content).includes("sleep 40"),
					),
				{ timeout: 180_000 },
			)
			.toBe(true);
		await expect
			.poll(async () => JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8")).length, {
				timeout: 30_000,
			})
			.toBe(1);

		const killedAt = Date.now();
		const child = first.process();
		const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		current = undefined;

		const second = await electron.launch({ args, env });
		current = second;
		const page2 = await second.firstWindow();
		await expect(page2.getByText("Continuing 1 interrupted task")).toBeVisible({ timeout: 60_000 });

		// Stock closed the cut-off call as "outcome unknown", ran it again and answered.
		await expect
			.poll(
				() =>
					sessionLines(agent).some(
						line =>
							line.message?.role === "assistant" &&
							line.message.stopReason === "stop" &&
							assistantText(line).includes("FINISHED-RESUME"),
					),
				{ timeout: 400_000 },
			)
			.toBe(true);
		expect(Date.now()).toBeGreaterThan(killedAt);
		await expect
			.poll(async () => JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8")), {
				timeout: 30_000,
			})
			.toEqual([]);
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
