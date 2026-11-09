/**
 * Stock's `ask` tool takes one HTML `<form>` (omp 18.18.3) and draws it whole only where the UI context has a
 * `formDialog` (the TUI, ACP). RPC has none, so stock walked the form field by field through `select`/`input`, and
 * the person saw each field's question and option labels only: the form's paragraphs, tables and pictures never
 * reached OMPdesk (9 Nov 2026: an agent asked the owner to pick one of three pictures it had drawn, and the card
 * showed none of them).
 *
 * This gives the session's RPC UI context a `formDialog` that asks the whole form as one ask card (stock's opt-in
 * `askDialog`, which sidecar.ts enables with `set_ask_dialog`): one question per named field, the content before it
 * (paragraphs, lists, tables, `<pre>`, `<img>`, `<svg>`) as Markdown in the question's `context`, which the card draws
 * above it the way a reply draws Markdown (a run of pictures side by side, each zoomable; a local picture read through
 * `fs.readImage`, so a paired computer and the phone read it from the host). The form's rules stay stock's:
 * `parseHtmlForm`, `fieldQuestions`, `choiceValue`, `textValue`, `fieldError`, `defaultFormData`.
 *
 * A field the person leaves unanswered keeps the form's own value (its preselected option, its prefilled text), as a
 * submitted form does. A timeout submits the values so far, as stock's form does.
 */
import type {
	ExtensionAPI,
	ExtensionAskDialogQuestion,
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent";
import {
	choiceValue,
	defaultFormData,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import {
	type FormBlock,
	type FormField,
	type FormSpan,
	type HtmlForm,
	parseHtmlForm,
	spansText,
} from "@oh-my-pi/pi-tui/html-form/parse";
import { disambiguateDisplayLabels } from "@oh-my-pi/pi-tui/render/render-utils";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = {};

/** One card question: its form field, the field's option index behind each card option, and the card's labels. */
interface Slot {
	field: FormField;
	optionIndices: number[];
	labels: string[];
	question: ExtensionAskDialogQuestion & { context?: string };
}

type AskDialog = NonNullable<ExtensionUIContext["askDialog"]>;

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Every ASCII punctuation mark escaped: CommonMark reads `\` before any of them as the literal mark. */
function escapeMarkdown(text: string): string {
	return text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

/** A fence (or a code span's ticks) longer than any run of backticks inside `text`. */
function ticks(text: string, least: number): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(run => run[0].length));
	return "`".repeat(Math.max(least, longest + 1));
}

function spansMarkdown(spans: readonly FormSpan[]): string {
	return spans
		.map(span => {
			if (span.style === "code") {
				const fence = ticks(span.text, 1);
				const pad = span.text.startsWith("`") || span.text.endsWith("`") ? " " : "";
				return `${fence}${pad}${span.text}${pad}${fence}`;
			}
			const text = span.text.split("\n").map(escapeMarkdown).join("\\\n");
			return span.style === "strong" ? `**${text}**` : span.style === "em" ? `*${text}*` : text;
		})
		.join("");
}

function blockMarkdown(block: Exclude<FormBlock, { kind: "field" }>): string {
	switch (block.kind) {
		case "text":
			return block.heading ? `**${spansMarkdown(block.spans)}**` : spansMarkdown(block.spans);
		case "list":
			return block.items
				.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${spansMarkdown(item)}`)
				.join("\n");
		case "pre": {
			const fence = ticks(block.text, 3);
			return `${fence}\n${block.text}\n${fence}`;
		}
		case "table": {
			const width = Math.max(...block.rows.map(row => row.length));
			const line = (cells: readonly FormSpan[][]) =>
				`| ${Array.from({ length: width }, (_, index) => spansMarkdown(cells[index] ?? [])).join(" | ")} |`;
			const [head = [], ...body] = block.rows;
			return [line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
		}
		case "image":
			// A backslash before punctuation is an escape in a destination too: `C:\Users\me\.omp\a.png` keeps its `\.`.
			return `![${escapeMarkdown(block.alt)}](<${block.src.replace(/[\\<>]/g, "\\$&")}>)`;
		case "svg":
			return `\`\`\`svg\n${block.markup}\n\`\`\``;
	}
}

/** The blocks as Markdown; pictures in a row share one paragraph, which the card draws as one figure row. */
function blocksMarkdown(blocks: readonly Exclude<FormBlock, { kind: "field" }>[]): string | undefined {
	let markdown = "";
	blocks.forEach((block, index) => {
		const text = blockMarkdown(block);
		if (!text) return;
		if (markdown) markdown += block.kind === "image" && blocks[index - 1]?.kind === "image" ? "\n" : "\n\n";
		markdown += text;
	});
	return markdown || undefined;
}

/** One card question per named field, each carrying the content between the previous field and it. */
function formSlots(form: HtmlForm): Slot[] {
	const asked = fieldQuestions(form);
	const slots: Slot[] = [];
	let pending: Exclude<FormBlock, { kind: "field" }>[] = [];
	for (const section of form.sections) {
		const title = oneLine(spansText(section.title));
		for (const block of section.blocks) {
			if (block.kind !== "field") {
				pending.push(block);
				continue;
			}
			const field = block.field;
			// An unnamed control submits nothing; stock's form skips it too.
			if (!field.name) continue;
			const question = asked.get(field) ?? field.name;
			// The paragraph stock made the field's question is not shown twice.
			const caption = pending.at(-1);
			if (caption?.kind === "text" && oneLine(spansText(caption.spans)) === question) pending.pop();
			const context = blocksMarkdown(pending);
			pending = [];
			const rows =
				field.kind === "choice"
					? field.options.flatMap((option, index) =>
							option.disabled ? [] : [{ index, label: oneLine(spansText(option.label)) || option.value }],
						)
					: [];
			const labels = disambiguateDisplayLabels(
				rows.map(row => row.label),
				[],
			);
			const recommended = field.kind === "choice" ? rows.findIndex(row => field.options[row.index]?.checked) : -1;
			slots.push({
				field,
				optionIndices: rows.map(row => row.index),
				labels,
				question: {
					id: `field-${slots.length}`,
					question,
					...(title && title !== question ? { header: title } : {}),
					options: labels.map(label => ({ label })),
					...(field.kind === "choice" && field.multi ? { multi: true } : {}),
					...(recommended >= 0 ? { recommended } : {}),
					...(context ? { context } : {}),
				},
			});
		}
	}
	// Content after the last field still belongs to the form: it shows with the last question.
	const last = slots.at(-1);
	const tail = blocksMarkdown(pending);
	if (last && tail) last.question.context = last.question.context ? `${last.question.context}\n\n${tail}` : tail;
	return slots;
}

/** The form's data with the card's answers applied; a question left unanswered keeps the form's own value. */
function applyAnswers(
	data: HtmlFormData,
	slots: readonly Slot[],
	results: ReadonlyArray<{ selectedOptions: string[]; customInput?: string }>,
): void {
	slots.forEach((slot, index) => {
		const result = results[index];
		const custom = result?.customInput ?? "";
		const picked = result?.selectedOptions ?? [];
		if (picked.length === 0 && custom.trim() === "") return;
		const { field } = slot;
		const value =
			field.kind === "text"
				? textValue(field, custom)
				: choiceValue(
						field,
						new Set(picked.flatMap(label => slot.optionIndices[slot.labels.indexOf(label)] ?? [])),
						custom,
					);
		if (value === undefined) delete data[field.name];
		else data[field.name] = value;
	});
}

/** Asks `html` on the card; a field the form refuses (a required one left empty, a bad number) is asked again. */
async function askForm(
	askDialog: AskDialog,
	html: string,
	options: ExtensionUIDialogOptions | undefined,
): Promise<ExtensionFormDialogResult | undefined> {
	const form = parseHtmlForm(html);
	const data = defaultFormData(form);
	let slots = formSlots(form);
	let timedOut = false;
	const dialogOptions: ExtensionUIDialogOptions = {
		...options,
		onTimeout: () => {
			timedOut = true;
			options?.onTimeout?.();
		},
	};
	while (slots.length > 0) {
		const result = await askDialog(
			slots.map(slot => slot.question),
			dialogOptions,
		);
		if (timedOut) return { data, timedOut: true };
		if (result?.kind !== "submit") return undefined;
		applyAnswers(data, slots, result.results);
		slots = slots.flatMap(slot => {
			const error = fieldError(slot.field, data[slot.field.name]);
			return error ? [{ ...slot, question: { ...slot.question, header: error } }] : [];
		});
	}
	return { data };
}

interface AskHost {
	askDialog?: ExtensionUIContext["askDialog"];
}

/**
 * `formDialog` on the RPC UI context itself, so every view of it (the runner's handler proxies, the tool contexts'
 * user-wait proxy) reads it. A getter: it exists only while the host has the ask card on, so a host that never opted
 * in keeps stock's field-by-field walk. An omp whose UI context has its own `formDialog` keeps it.
 */
function attach(pi: ExtensionAPI): void {
	const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
	const runner = session?.extensionRunner;
	if (!runner?.hasUI()) return;
	const ui = runner.getUIContext();
	if ("formDialog" in ui) return;
	Object.defineProperty(ui, "formDialog", {
		configurable: true,
		get(this: AskHost) {
			const askDialog = this.askDialog;
			return askDialog
				? (html: string, options?: ExtensionUIDialogOptions) => askForm(askDialog, html, options)
				: undefined;
		},
	});
}

export function install(pi: ExtensionAPI): void {
	attach(pi);
	pi.on("session_start", () => attach(pi));
}
