import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { CustomMessageCard, workNoteSummary } from "./CustomMessageCard";
import { WorkNotes } from "./WorkNotes";

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
	it("renders one row per delivered job", () => {
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
		expect(markup).toContain("[bash]");
		expect(markup).toContain("[task]");
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
