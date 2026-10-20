/**
 * Memory's quality upkeep on the fake binary: when the server answers, the app repairs what the old titling left behind,
 * through the server's own write paths. The fake project `gamma` holds a session page titled by the agent-message wrapper
 * and an open handoff a child session left next to one a person's session left: the page is rewritten under its task's
 * `Title:` (an MCP `memory_write_page` for that session with the page's version as precondition), the child's handoff is
 * cancelled, the person's is not.
 */
import * as fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { launch, makeRig, phaseIs } from "./fixture/ai-memory-rig";
import { stopFakeServer } from "./fixture/fake-ai-memory-install";
import { exitApp } from "./harness";

interface Logged {
	path: string;
	tool?: string;
	body?: { params?: { arguments?: Record<string, unknown> } };
}

test("the upkeep retitles a junk session page and discards a child's handoff once the server answers", async () => {
	test.setTimeout(180_000);
	process.env.FAKE_AI_MEMORY_UPKEEP = "1";
	const rig = await makeRig();
	let current: Awaited<ReturnType<typeof launch>> | null = null;
	try {
		current = await launch(rig);
		await phaseIs(current.page, "ready");
		const requests = async (): Promise<Logged[]> =>
			(await fs.readFile(`${rig.memory.env.FAKE_AI_MEMORY_LOG}.requests`, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Logged);
		await expect
			.poll(async () => (await requests()).filter(entry => entry.tool === "memory_write_page").length, {
				timeout: 60_000,
			})
			.toBe(1);
		const all = await requests();
		const write = all.find(entry => entry.tool === "memory_write_page")?.body?.params?.arguments;
		expect(write).toMatchObject({
			project: "gamma",
			path: "sessions/junk1.md",
			session_id: "junk1",
			tier: "episodic",
		});
		expect(String(write?.body)).toContain("# 맥 자동업데이트 확인\n");
		expect(String(write?.body)).toContain("1. 맥 자동업데이트 확인");
		expect(String(write?.body)).not.toContain("ompdesk-agent-message");
		expect(typeof write?.expected_page_id).toBe("string");
		// The repair retitles first and cancels the child's handoff after: read the log until the cancel is in (a hosted
		// runner's single read right after the write found none).
		const cancelled = async () =>
			(await requests())
				.filter(entry => entry.tool === "memory_handoff_cancel")
				.map(entry => entry.body?.params?.arguments?.handoff_id);
		await expect.poll(cancelled, { timeout: 30_000 }).toEqual(["h-child"]);
	} finally {
		delete process.env.FAKE_AI_MEMORY_UPKEEP;
		if (current) await exitApp(current.app).catch(() => undefined);
		await stopFakeServer(rig.home);
		await fs.rm(rig.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
