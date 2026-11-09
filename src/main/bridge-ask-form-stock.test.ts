import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import type { ExtensionAskDialogQuestion } from "../shared/rpc-types";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Pins the bridge's ask form (resources/gui-bridge/ask-form.ts) to the installed omp: stock's own `ask` tool, run in
 * `--mode rpc-ui` through the session's real tool context with the host opted into the ask card (`set_ask_dialog`, as
 * sidecar.ts does), asks a form of pictures and a choice. Without the bridge stock walks the form field by field
 * (`select` "Pick one": A, B, C, Other), and the paragraph and pictures never leave omp (9 Nov 2026: an agent asked
 * the owner to choose among three pictures it had drawn, and the card showed none).
 */

const PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FORM = `<form>
  <p>Three logo drafts, 1*2 = <b>sizes</b> differ:</p>
  <img src="logo-a.png" alt="A: round">
  <img src="${PIXEL}" alt="B: square">
  <svg viewBox="0 0 10 10" aria-label="C: drawn"><rect width="10" height="10"/></svg>
  <fieldset>
    <legend>Logo</legend>
    <p>Which logo should ship?</p>
    <label><input type="radio" name="logo" value="a" checked> A</label>
    <label><input type="radio" name="logo" value="b"> B</label>
    <label><input type="radio" name="logo" value="c"> C</label>
  </fieldset>
  <label>Notes <input type="text" name="notes" value="none"></label>
</form>`;

const PROBE = `
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { install } from "./ask-form";
export default function (pi) {
 pi.on("session_start", () => {
  setTimeout(async () => {
   try {
    install(pi);
    const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
    const context = session.getToolByName("read").session.getToolContext();
    const result = await new AskTool({ settings: session.settings, hasUI: true }).execute("ask-1", { html: process.env.PROBE_FORM }, undefined, undefined, context);
    console.error("ASK_FORM_PROBE=" + JSON.stringify(result.content));
   } catch (err) {
    console.error("ASK_FORM_PROBE_ERROR=" + String(err && err.stack || err));
   }
   process.exit(0);
  }, 200);
 });
}
`;

interface Frame {
	type: string;
	id?: string;
	method?: string;
	title?: string;
	options?: string[];
	questions?: ExtensionAskDialogQuestion[];
}

/** Runs the probe; `answer` replies to each dialog frame omp sends. Resolves with those frames and the tool's text. */
async function askForm(answer: (frame: Frame) => Record<string, unknown>): Promise<{ frames: Frame[]; text: string }> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-ask-form-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "ask-form-probe.ts");
		writeFileSync(extension, PROBE);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			PROBE_FORM: FORM,
		};
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				extension,
			],
			{ cwd: isolated, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		const send = (frame: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(frame)}\n`);
		send({ type: "set_ask_dialog", enabled: true });
		const frames: Frame[] = [];
		createInterface({ input: child.stdout }).on("line", line => {
			const frame = JSON.parse(line) as Frame;
			if (
				frame.type !== "extension_ui_request" ||
				!["ask", "select", "input", "editor"].includes(frame.method ?? "")
			)
				return;
			frames.push(frame);
			send({ type: "extension_ui_response", id: frame.id, ...answer(frame) });
		});
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += String(chunk);
		});
		await once(child, "exit");
		const line = stderr.split("\n").find(value => value.startsWith("ASK_FORM_PROBE="));
		expect(line, stderr.slice(-2500)).toMatch(/^ASK_FORM_PROBE=/);
		const content = JSON.parse(line?.slice("ASK_FORM_PROBE=".length) ?? "[]") as Array<{ text: string }>;
		return { frames, text: content.map(block => block.text).join("\n") };
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("an ask form on stock omp", () => {
	it("reaches the card whole, pictures above the question, and the answer comes back as the form's data", async () => {
		const { frames, text } = await askForm(frame =>
			frame.method === "ask"
				? {
						answers: (frame.questions ?? []).map((question, index) => ({
							id: question.id,
							selectedOptions: index === 0 ? ["B"] : [],
						})),
					}
				: { value: frame.options?.[1] ?? "x" },
		);
		// One card, no field-by-field prompts.
		expect(frames.map(frame => frame.method)).toEqual(["ask"]);
		const [logo, notes] = frames[0]?.questions ?? [];
		expect(logo).toMatchObject({
			question: "Which logo should ship?",
			header: "Logo",
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
			recommended: 0,
		});
		// The paragraph as written (Markdown punctuation escaped), the pictures as one row, the drawing as a figure.
		expect(logo?.context).toContain("Three logo drafts\\, 1\\*2 \\= **sizes** differ\\:");
		expect(logo?.context).toContain(`![A\\: round](<logo-a.png>)\n![B\\: square](<${PIXEL}>)`);
		expect(logo?.context).toMatch(/```svg\n<svg[^\n]*aria-label="C: drawn"/);
		expect(notes).toMatchObject({ question: "Notes", options: [] });
		expect(notes?.context).toBeUndefined();
		// The untouched text field keeps the form's own value, as a submitted form does.
		expect(JSON.parse(text.slice(text.indexOf("{")))).toEqual({ logo: "b", notes: "none" });
	}, 150_000);
});
