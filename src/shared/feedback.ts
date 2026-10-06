/**
 * Feedback → GitHub issue bridge. Builds the `issues/new` URL the dialog
 * opens; nothing is sent until the user confirms on GitHub, and no session
 * content is ever included — only what the dialog previews.
 *
 * Shared (not renderer-only) because the error log tail is assembled in the
 * main process and the fallback page uses the same URL builder.
 */

import type { RuntimeErrorReport } from "./ipc-types";

export const FEEDBACK_REPO = "https://github.com/SeuPut0705/omp-gui";

export type FeedbackKind = "bug" | "feature" | "question";

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ["bug", "feature", "question"];

const KIND_LABELS: Record<FeedbackKind, string> = {
	bug: "bug",
	feature: "enhancement",
	question: "question",
};

const KIND_TITLE: Record<FeedbackKind, string> = {
	bug: "[Bug] ",
	feature: "[Feature] ",
	question: "[Question] ",
};

export interface FeedbackEnvironment {
	appVersion: string;
	platform: string;
	arch: string;
	electron: string;
	chrome: string;
}

export interface FeedbackInput {
	kind: FeedbackKind;
	title: string;
	description: string;
	environment?: FeedbackEnvironment | null;
	/** Runtime error lines the user opted into. */
	errors?: readonly string[];
	/** Error text carried in from a crash page or error surface. */
	prefillError?: string | null;
}

/** One parsed runtime log line, rendered as a compact single-line summary. */
interface RuntimeLogEntry {
	ts?: string;
	report?: RuntimeErrorReport;
	appVersion?: string;
}

/** Keep the whole URL comfortably under every browser's practical limit. */
const MAX_URL_LENGTH = 8000;
const MAX_ERRORS_CHARS = 3000;
const STACK_HEAD_LINES = 6;
const STACK_HEAD_CHARS = 1200;

function compactStack(stack: string | undefined): string {
	if (!stack) return "";
	return stack.split("\n").slice(0, STACK_HEAD_LINES).join("\n").slice(0, STACK_HEAD_CHARS);
}

function toErrorLine(raw: string): string | null {
	try {
		const entry = JSON.parse(raw) as RuntimeLogEntry | RuntimeErrorReport;
		const report = "report" in entry && entry.report ? entry.report : (entry as RuntimeErrorReport);
		const message = typeof report.message === "string" ? report.message : "";
		if (!message) return null;
		const stack = compactStack(report.stack);
		return `\`${report.source ?? "unknown"}\` ${message}${stack ? `\n\`\`\`\n${stack}\n\`\`\`` : ""}`;
	} catch {
		// Tail reads can cut the first line mid-JSON — drop unparseable lines.
		return null;
	}
}

/** Newest-last render of the given tail lines, bounded to MAX_ERRORS_CHARS. */
export function formatErrorTail(rawLines: readonly string[]): string {
	const lines: string[] = [];
	let size = 0;
	for (const raw of rawLines) {
		const line = toErrorLine(raw);
		if (line === null) continue;
		if (size + line.length > MAX_ERRORS_CHARS) break;
		lines.push(line);
		size += line.length;
	}
	return lines.join("\n");
}

export function buildIssueBody(input: FeedbackInput): string {
	const sections: string[] = [];
	const description = input.description.trim();
	if (description) sections.push(description);
	const details: string[] = [];
	if (input.prefillError) details.push(input.prefillError.trim());
	if (input.errors && input.errors.length > 0) {
		const tail = formatErrorTail(input.errors);
		if (tail) details.push(tail);
	}
	if (details.length > 0) {
		sections.push(`### Error details\n\n<details>\n\n${details.join("\n\n")}\n\n</details>`);
	}
	if (input.environment) {
		const env = input.environment;
		sections.push(
			`### Environment\n\n- omp GUI: v${env.appVersion}\n- OS: ${env.platform} ${env.arch}\n- Electron ${env.electron} · Chrome ${env.chrome}`,
		);
	}
	sections.push("---\n*Reported from the omp GUI feedback dialog.*");
	return sections.join("\n\n");
}

export function buildIssueUrl(input: FeedbackInput): string {
	const url = new URL(`${FEEDBACK_REPO}/issues/new`);
	const description = input.description.trim();
	url.searchParams.set("title", `${KIND_TITLE[input.kind]}${input.title.trim()}`.trim());
	url.searchParams.set("labels", `gui,${KIND_LABELS[input.kind]}`);
	// URL-encoding roughly triples non-ASCII text; shrink the body until the
	// finished URL fits. The dialog copy tells the user the paste stays editable.
	let body = buildIssueBody({ ...input, description });
	url.searchParams.set("body", body);
	while (url.toString().length > MAX_URL_LENGTH && body.length > 400) {
		body = `${body.slice(0, Math.floor(body.length * 0.8)).trimEnd()}…`;
		url.searchParams.set("body", body);
	}
	return url.toString();
}
