import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { CustomMessageCard, MailNote, RecapCard, workNoteSummary } from "./CustomMessageCard";
import { WorkNotes } from "./work/WorkNotes";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;

function asyncResult(details: unknown, content = "Background job finished.\njobs/batch-1.log"): AgentMessage {
	return { role: "custom", customType: "async-result", content, details, timestamp: 1 };
}

function html(message: AgentMessage): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<CustomMessageCard message={message} />
		</I18nProvider>,
	);
}

describe("async-result card", () => {
	it("renders one row per delivered job, its kind in words", () => {
		const markup = html(
			asyncResult({
				jobs: [
					{ jobId: "batch-1", type: "bash", label: "gui tests", durationMs: 1200 },
					{ jobId: "batch-2", type: "task", label: "audit sweep", durationMs: 4200 },
				],
			}),
		);

		expect(markup).toContain("gui tests");
		expect(markup).toContain("audit sweep");
		expect(markup).toContain("Background job completed · Run command · batch-1 · 1.2s");
		expect(markup).toContain("Background job completed · Subagent · batch-2 · 4.2s");
		expect(markup).not.toContain("[bash]");
		expect(markup).not.toContain("[task]");
	});

	it("names a subagent job once when its id is its label", () => {
		const markup = html(
			asyncResult({ jobs: [{ jobId: "Sleeper", type: "task", label: "Sleeper", durationMs: 67_000 }] }),
		);
		expect(markup.replace(/<[^>]+>/g, " ").match(/Sleeper/g)).toHaveLength(1);
	});

	it("shows the delivery text instead of inventing a job row when no jobs arrived", () => {
		// The card used to fold the whole `details` object into one fake job, so
		// a malformed batch claimed an `[job]` named "unknown".
		const markup = html(asyncResult({ meta: { source: "background job delivery" } }, "Nothing to report."));

		expect(markup).toContain("Nothing to report.");
		expect(markup).not.toContain("unknown");
		expect(markup).not.toContain("[job]");
	});
});

describe("standalone cards", () => {
	const card = (customType: string, details: unknown, content = "") =>
		html({ role: "custom", customType, content, details, display: true, timestamp: 1 });

	it("frame advisor, skill and handoff as colorless hairline cards with cased labels", () => {
		const advisor = card("advisor", { notes: [{ note: "Pin the server.", severity: "concern" }] });
		const skill = card("skill-prompt", { name: "release-checklist" }, "Run the checklist.");
		const handoff = card("handoff", {}, "<handoff-context>Carry on.</handoff-context>");
		for (const markup of [advisor, skill, handoff]) {
			expect(markup).toContain("border-(--sc-border-subtle)");
			expect(markup).not.toContain("--omp-custom-msg");
			expect(markup).not.toContain("uppercase");
			expect(markup).not.toContain("shadow");
		}
		expect(advisor).toContain(">Advisor<");
		expect(advisor).toContain(">Concern<");
		// The severity is the one state mark that keeps its color.
		expect(advisor).toContain("--sc-warning-soft");
		expect(skill).toContain(">Skill<");
		expect(skill).toContain('aria-expanded="false"');
		expect(skill).toContain("omp-disclosure-chevron");
		expect(handoff).toContain(">Handoff<");
	});

	it("names no skill rather than an English placeholder when stock sent none", () => {
		const skill = card("skill-prompt", {});
		expect(skill).toContain(">Skill<");
		expect(skill).not.toContain("unknown");
		// Nothing to open: the header is not a button.
		expect(skill).not.toContain("<button");
	});
});

it("previews the human summary inside stock task completion envelopes", () => {
	const message = asyncResult(
		{ jobs: [{ jobId: "AlphaCounter", type: "task", label: "AlphaCounter" }] },
		'<system-notice>\nBackground job AlphaCounter has completed. Resume your work using the result below.\n<task-result id="AlphaCounter" agent="task" status="completed" duration="11.6s">\n<meta lines="3" size="46B" />\n<output>\n{\n  "summary": "alpha.txt contains 3 lines."\n}\n</output>\n</task-result>\n\nAlphaCounter is now idle — message it via `write agent://AlphaCounter` to follow up.\n</system-notice>',
	);
	expect(workNoteSummary(message).source).toBe("AlphaCounter");
	expect(workNoteSummary(message).body).toBe("alpha.txt contains 3 lines.");
	const preview = renderToStaticMarkup(
		<I18nProvider>
			<WorkNotes messages={[message]} />
		</I18nProvider>,
	);
	expect(preview).toContain("alpha.txt contains 3 lines.");
	expect(preview).not.toContain("system-notice");
	expect(preview).not.toContain("task-result");
	// Full completion details keep their existing disclosure/body renderer.
	expect(html(message)).toContain("task-result");
});

it("previews parsed bash delivery output and strips launch notification envelopes", () => {
	expect(
		workNoteSummary(
			asyncResult(
				{ jobs: [{ jobId: "bg-7", type: "bash", label: "build" }] },
				"<system-notice>\nBackground job bg-7 has completed.\nBUILD_OUTPUT\nSecond line\n</system-notice>",
			),
		).body,
	).toBe("BUILD_OUTPUT");
	expect(
		workNoteSummary({
			role: "custom",
			customType: "launch-completion",
			content: "<system-notice>\nSupervised process smoke failed with exit code 1.\n</system-notice>",
			details: { daemons: [{ name: "smoke", state: "failed", exitCode: 1 }] },
		}).body,
	).toBe("Supervised process smoke failed with exit code 1.");
});

describe("recap card", () => {
	const recap: AgentMessage = {
		role: "custom",
		customType: "recap",
		content: "You are wiring the recap card. Next: run the checks.",
		display: true,
		details: { recap: "full reply" },
		timestamp: 1,
	};

	it("is one quiet muted line with its label, not a bordered card", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider>
				<RecapCard message={recap} />
			</I18nProvider>,
		);
		expect(markup).toContain("data-recap");
		expect(markup).toContain("Recap");
		expect(markup).toContain("You are wiring the recap card. Next: run the checks.");
		expect(markup).not.toContain("border");
	});

	it("renders nothing for an empty recap", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider>
				<RecapCard message={{ ...recap, content: "  " }} />
			</I18nProvider>,
		);
		expect(markup).toBe("");
	});
});

describe("session report line", () => {
	const mail = (details: Record<string, unknown>): AgentMessage => ({
		role: "custom",
		customType: "ompdesk.mail",
		content: "<ompdesk-mail …>",
		display: true,
		details,
		timestamp: 1,
	});

	it("is one quiet line naming the sender and the kind, never the model-facing envelope", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider>
				<MailNote
					message={mail({
						kind: "done",
						from: "abc",
						fromTitle: "Part A",
						text: "A finished",
						files: ["src/a.ts"],
						checks: [{ command: "bun test", passed: true }],
					})}
				/>
			</I18nProvider>,
		);
		expect(markup).toContain('data-agent-mail="done"');
		expect(markup).toContain("Session report · Part A");
		expect(markup).toContain("A finished");
		expect(markup).toContain("src/a.ts");
		expect(markup).not.toContain("ompdesk-mail");
		expect(markup).not.toContain("border");
	});

	it("tints a question that waits on this session", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider>
				<MailNote message={mail({ kind: "question", from: "abc", text: "Keep it?" })} />
			</I18nProvider>,
		);
		expect(markup).toContain("--sc-warning");
	});
});
