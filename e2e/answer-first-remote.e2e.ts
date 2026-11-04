/**
 * A message a paired computer's tab sends into a session the HOST runs, while that session's turn runs, reaches the
 * host's omp as a typed note (`typed_prompt`, steer: true) right before the stock steer, so the omp answers it first.
 * The prompt that started the turn is noted too, with steer: false. Unit counterparts: `prompt-origin.test.ts`
 * (`noteTypedPrompt`) and `host-services` (`#run`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, openHostFolder, type RemoteInstance } from "./remote-harness";

const QUESTION = "어느정도 됐어?";
const SENDS: Record<string, true> = { prompt: true, steer: true, follow_up: true, typed_prompt: true };

test("a message a paired computer's tab sends into a running host turn is noted as a typed steer before the steer", async () => {
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-answer-first-remote-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", { language: "en", theme: "light" });
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const a = client.page;
		const deviceId = await connectHost(host.page, a, "PC-B");
		await openHostFolder(a, deviceId, hostProfile.project);

		const input = a.locator("textarea").first();
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(a.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(a.locator("[data-send-mode]")).toHaveAttribute("data-send-mode", "steer", { timeout: 30_000 });

		await input.fill(QUESTION);
		await expect(a.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
		await input.press("Enter");

		const sends = async () =>
			(await readRecords(hostProfile.record)).filter(
				record => typeof record.type === "string" && SENDS[record.type] === true,
			);
		const textOf = (record: Record<string, unknown>) =>
			record.type === "typed_prompt" ? record.text : record.message;
		await expect
			.poll(
				async () => (await sends()).some(record => record.type !== "typed_prompt" && textOf(record) === QUESTION),
				{
					timeout: 30_000,
				},
			)
			.toBe(true);

		const frames = await sends();
		const first = frames.findIndex(record => record.type === "typed_prompt" && record.text === "fixture running");
		expect(first).toBeGreaterThanOrEqual(0);
		expect(frames[first]).toMatchObject({ steer: false });
		expect(frames[first + 1]).toMatchObject({ type: "prompt", message: "fixture running" });

		const note = frames.findIndex(record => record.type === "typed_prompt" && record.text === QUESTION);
		expect(note).toBeGreaterThan(first);
		expect(frames[note]).toMatchObject({ steer: true });
		// The very next send is the steer carrying the text: nothing between the note and it.
		const joined = frames[note + 1];
		expect(joined).toBeDefined();
		expect(joined?.message).toBe(QUESTION);
		const asSteer = joined?.type === "steer" || (joined?.type === "prompt" && joined.streamingBehavior === "steer");
		expect(asSteer, JSON.stringify(joined)).toBe(true);
		expect(host.errors).toEqual([]);
		expect(client.errors).toEqual([]);
	} finally {
		if (client) await exitApp(client.app);
		if (host) await exitApp(host.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
