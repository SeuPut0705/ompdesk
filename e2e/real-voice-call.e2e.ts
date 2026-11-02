import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp } from "./harness";
import { realOmpProfile } from "./real-omp";
import { type Clip, instrument, type LogEntry, readLog, say, speak, type Utterance } from "./real-voice";

// Explicit opt-in (`OMP_GUI_REAL_WORK=1`, macOS): a whole voice call with the bot on the installed omp, its real
// streaming STT (the dictation model) and TTS (Kokoro), the bot answering on the user's `smol` model. Speech comes
// from macOS `say` and is played into the call's microphone (e2e/real-voice.ts); audio output is muted. The model
// caches (`~/.omp/agent/cache`) are linked into the private agent dir, so nothing is downloaded.
//
// It measures, per utterance: when the call heard speech, when it decided the speech ended, when the final text was
// there, when it reached the bot, and when the reply's first sound was scheduled; then barge-in while a reply plays,
// a second utterance while the first is still being transcribed, mute, Korean, and End during a reply. The numbers go
// to `OMP_GUI_REAL_WORK_ARTIFACTS` (default the OS temp dir) as real-voice-call.json and real-voice-call.md.
// The machine itself is unit-tested in voice-call.test.ts, BotCallBar.test.tsx and bridge-voice-stream(-stock).test.ts.

const UTTERANCES: Utterance[] = [
	{ name: "sky", voice: "Samantha", text: "Hello there. Please answer in one short sentence. What color is the sky?" },
	{
		name: "count",
		voice: "Samantha",
		text: "Please count slowly from one to thirty, writing every number as a word, separated by commas.",
	},
	{ name: "stop", voice: "Samantha", text: "Wait, stop. Tell me something else instead." },
	{ name: "first", voice: "Samantha", text: "Remember the word banana." },
	{ name: "second", voice: "Samantha", text: "And what is two plus two?" },
	{ name: "korean", voice: "Yuna", text: "안녕하세요. 하늘은 무슨 색인가요? 한 문장으로 짧게 대답해 주세요." },
];

interface Row {
	scenario: string;
	clipMs: number;
	/** Each a delay in ms; null when it did not happen. */
	heardAfterOnset: number | null;
	endDetectedAfterSpeech: number | null;
	transcriptAfterSpeech: number | null;
	sentAfterSpeech: number | null;
	firstAudioAfterTurnEnd: number | null;
	firstAudioAfterSpeech: number | null;
	transcript: string;
}

const round = (value: number | undefined): number | null => (value === undefined ? null : Math.round(value));

/** The log from `from` on (page clock), entries as the call saw them. */
const since = (log: LogEntry[], from: number) => log.filter(entry => entry.t >= from);
const bars = (log: LogEntry[]) => log.filter(entry => entry.kind === "bar" && entry.partial !== true);
const heardText = (entry: LogEntry | undefined) => String(entry?.heard ?? "").replace(/^“|”$/g, "");

/** One utterance's numbers from the log, `clip` played at `at`…`end`. */
function measure(scenario: string, log: LogEntry[], clip: Clip, at: number, end: number): Row {
	const after = since(log, at - 100);
	const hearing = bars(after).find(entry => entry.phase === "hearing");
	// Every bar entry: the one that leaves hearing still shows the running text (`partial`) until the final text lands.
	const left = after.find(entry => entry.kind === "bar" && entry.t > (hearing?.t ?? at) && entry.phase !== "hearing");
	const final = bars(after).find(
		entry => entry.t >= (left?.t ?? at) && (entry.phase === "waiting" || entry.phase === "speaking") && entry.heard,
	);
	// The message that carries these words (an earlier utterance's may go out after this one started).
	const sent = after.find(
		entry => entry.kind === "message_start" && entry.role === "user" && entry.t >= (final?.t ?? at),
	);
	const turnEnd = after.find(entry => entry.kind === "agent_end" && entry.t >= (sent?.t ?? at));
	const play = after.find(entry => entry.kind === "play" && entry.t >= (turnEnd?.t ?? Number.POSITIVE_INFINITY));
	const playAt = typeof play?.at === "number" ? play.at : undefined;
	return {
		scenario,
		clipMs: Math.round(clip.ms),
		heardAfterOnset: round(hearing && hearing.t - at),
		endDetectedAfterSpeech: round(left && left.t - end),
		transcriptAfterSpeech: round(final && final.t - end),
		sentAfterSpeech: round(sent && sent.t - end),
		firstAudioAfterTurnEnd: round(playAt !== undefined && turnEnd ? playAt - turnEnd.t : undefined),
		firstAudioAfterSpeech: round(playAt !== undefined ? playAt - end : undefined),
		transcript: heardText(final),
	};
}

function table(rows: Row[], notes: string[]): string {
	const head =
		"| scenario | clip ms | heard after onset | end detected after speech | final text after speech | sent after speech | first audio after turn end | first audio after speech | transcript |";
	const lines = rows.map(
		row =>
			`| ${row.scenario} | ${row.clipMs} | ${row.heardAfterOnset ?? "–"} | ${row.endDetectedAfterSpeech ?? "–"} | ${row.transcriptAfterSpeech ?? "–"} | ${row.sentAfterSpeech ?? "–"} | ${row.firstAudioAfterTurnEnd ?? "–"} | ${row.firstAudioAfterSpeech ?? "–"} | ${row.transcript} |`,
	);
	return [head, `|${" --- |".repeat(9)}`, ...lines, "", ...notes.map(note => `- ${note}`), ""].join("\n");
}

test("real omp voice call with the bot: streaming speech both ways, barge-in, a second utterance, mute, end", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.skip(process.platform !== "darwin", "Speech comes from macOS `say`");
	test.setTimeout(900_000);
	const { profile, project, desktop, agent } = await realOmpProfile({ botEnabled: true, theme: "light" });
	await fs.symlink(path.join(os.homedir(), ".omp/agent/cache"), path.join(agent, "cache"));
	const clips = new Map<string, Clip>();
	for (const utterance of UTTERANCES) clips.set(utterance.name, await speak(profile, utterance));
	const clip = (name: string): Clip => {
		const found = clips.get(name);
		if (!found) throw new Error(`no clip ${name}`);
		return found;
	};

	let app: ElectronApplication | undefined;
	const errors: string[] = [];
	const rows: Row[] = [];
	const artifacts = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? os.tmpdir();
	await fs.mkdir(artifacts, { recursive: true });
	const notes: string[] = [];
	try {
		app = await launchApp({
			project,
			desktop,
			agent,
			profile,
			env: { OMP_GUI_OMP: undefined },
			args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--mute-audio"],
		});
		const page: Page = await app.firstWindow();
		page.on("pageerror", error => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 120_000 })
			.toMatchObject({ status: "ready" });
		await page.locator("[data-sidebar-bot-row]").click({ timeout: 120_000 });
		const pane = page.locator(".omp-session-pane:visible").first();
		await expect(pane.locator("[data-bot-call-start]")).toBeVisible({ timeout: 60_000 });
		await instrument(page, [...clips.values()]);
		const bar = pane.locator("[data-bot-call-bar]");
		const phase = bar.and(page.locator("[data-bot-call-phase]"));
		const now = () => page.evaluate(() => performance.now());
		const capture = async (name: string) =>
			fs.writeFile(path.join(artifacts, `${name}.png`), await page.screenshot({ animations: "disabled" }));
		const log = () => readLog(page);
		/** Until the call rests in `listening` after the turn(s) since `from` ended. */
		const settled = async (from: number, turns = 1) =>
			expect
				.poll(
					async () => {
						const after = since(await log(), from);
						const ended = after.filter(entry => entry.kind === "agent_end").length >= turns;
						return ended && (await bar.getAttribute("data-bot-call-phase")) === "listening";
					},
					{ timeout: 180_000, intervals: [250] },
				)
				.toBe(true);

		await pane.locator("[data-bot-call-start]").click();
		await expect(phase).toHaveAttribute("data-bot-call-phase", "listening", { timeout: 30_000 });
		// The VAD measures the floor over its first ticks.
		await page.waitForTimeout(800);
		await capture("desktop-call-listening");

		// 1. One English question: heard, transcribed while spoken, sent, answered and spoken.
		const sky = await say(page, "sky");
		await settled(sky.at);
		const skyRow = measure("question (en)", await log(), clip("sky"), sky.at, sky.end);
		rows.push(skyRow);
		expect(skyRow.transcript.toLowerCase()).toContain("sky");
		expect(skyRow.firstAudioAfterTurnEnd, "the reply was spoken").not.toBeNull();

		// 2. Talking over a long reply 300 ms after its sound starts: playback stops, every word is heard.
		const count = await say(page, "count");
		await expect
			.poll(async () => since(await log(), count.at).some(entry => entry.kind === "play"), { timeout: 120_000 })
			.toBe(true);
		const firstPlay = since(await log(), count.at).find(entry => entry.kind === "play");
		const playAt = typeof firstPlay?.at === "number" ? firstPlay.at : await now();
		await page.waitForTimeout(Math.max(0, playAt + 300 - (await now())));
		const stop = await say(page, "stop");
		await settled(count.at, 2);
		const afterStop = since(await log(), stop.at - 50);
		const silenced = afterStop.find(entry => entry.kind === "stopSound");
		rows.push(measure("long reply (en)", await log(), clip("count"), count.at, count.end));
		const stopRow = measure("barge-in (en)", await log(), clip("stop"), stop.at, stop.end);
		rows.push(stopRow);
		const bargeMs = round(silenced && silenced.t - stop.at);
		notes.push(`Barge-in: the reply's sound stopped ${bargeMs ?? "–"} ms after the person started talking over it.`);
		expect(bargeMs, "the reply stopped when talked over").not.toBeNull();
		expect(stopRow.transcript.toLowerCase()).toMatch(/^wait\b/);

		// 3. A second utterance as soon as the call listens again after the first. The streamed stop then usually has
		// already answered (a few ms to ~40 ms): the note records whether the second one started inside that window.
		const first = await say(page, "first");
		await expect
			.poll(
				async () => {
					const after = since(await log(), first.at).filter(entry => entry.kind === "bar");
					const heard = after.findIndex(entry => entry.phase === "hearing");
					return heard !== -1 && after.slice(heard + 1).some(entry => entry.phase !== "hearing");
				},
				{ timeout: 30_000, intervals: [10] },
			)
			.toBe(true);
		const second = await say(page, "second");
		await settled(second.at);
		const sent = since(await log(), first.at)
			.filter(entry => entry.kind === "message_start" && entry.role === "user")
			.map(entry => String(entry.text));
		expect(sent).toHaveLength(2);
		expect(sent[0]?.toLowerCase()).toContain("banana");
		expect(sent[1]?.toLowerCase()).toMatch(/two plus two|2 plus 2|2\s*\+\s*2/);
		rows.push(measure("second utterance (en)", await log(), clip("second"), second.at, second.end));
		const firstBars = since(await log(), first.at).filter(entry => entry.kind === "bar");
		const firstHeard = firstBars.findIndex(entry => entry.phase === "hearing");
		const listening = firstBars.slice(firstHeard + 1).find(entry => entry.phase !== "hearing");
		const firstFinal = firstBars.find(entry => entry.t >= (listening?.t ?? 0) && heardText(entry).includes("banana"));
		const stopMs = round(listening && firstFinal && firstFinal.t - listening.t);
		const overlap = firstFinal !== undefined && second.at < firstFinal.t;
		notes.push(
			`Second utterance: the first one's final text came ${stopMs ?? "–"} ms after the call listened again; the second clip started ${Math.round(second.at - (firstFinal?.t ?? second.at))} ms relative to that (${overlap ? "inside" : "after"} the pending stop); both were sent in order.`,
		);

		// 4. Korean: whatever the configured dictation model makes of it.
		const korean = await say(page, "korean");
		await settled(korean.at);
		rows.push(measure("question (ko)", await log(), clip("korean"), korean.at, korean.end));

		// 5. Muted: nothing is heard, the mic track is off.
		const mute = bar.locator("[data-bot-call-mute]");
		await mute.click();
		await expect(mute).toHaveAttribute("aria-pressed", "true");
		expect(
			await page.evaluate(() =>
				(Reflect.get(window, "__voiceMic") as { destination: MediaStreamAudioDestinationNode }).destination.stream
					.getAudioTracks()
					.map(track => track.enabled),
			),
		).toEqual([false]);
		const muted = await say(page, "second");
		await page.waitForTimeout(muted.end - muted.at + 1_500);
		expect(bars(since(await log(), muted.at)).map(entry => entry.phase)).not.toContain("hearing");
		await mute.click();
		await expect(mute).toHaveAttribute("aria-pressed", "false");
		await page.waitForTimeout(500);

		// 6. End while the reply is being spoken: the bar goes, the mic is released, nothing plays afterwards.
		await say(page, "sky");
		await expect(phase).toHaveAttribute("data-bot-call-phase", "speaking", { timeout: 120_000 });
		await capture("desktop-call-speaking");
		const endAt = await now();
		await bar.locator("[data-bot-call-end]").click();
		await expect(bar).toHaveCount(0);
		await page.waitForTimeout(3_000);
		expect(since(await log(), endAt).filter(entry => entry.kind === "play")).toEqual([]);
		expect(
			await page.evaluate(() =>
				(Reflect.get(window, "__voiceMic") as { destination: MediaStreamAudioDestinationNode }).destination.stream
					.getAudioTracks()
					.map(track => track.readyState),
			),
		).toEqual(["ended"]);
		const endBar = bars(since(await log(), endAt)).find(entry => entry.phase === "ended" || entry.phase === "none");
		notes.push(`End during a reply: the call ended ${round(endBar && endBar.t - endAt) ?? "–"} ms after the click.`);
	} finally {
		if (app) await exitApp(app);
		await fs.writeFile(path.join(artifacts, "real-voice-call.json"), JSON.stringify({ rows, notes }, null, 2));
		await fs.writeFile(path.join(artifacts, "real-voice-call.md"), table(rows, notes));
		console.log(table(rows, notes));
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	expect(errors).toEqual([]);
});
