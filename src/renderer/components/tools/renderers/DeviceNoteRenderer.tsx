import { resultText } from "../../../lib/format";
import { MarkdownRenderer } from "../../../lib/markdown";
import type { ToolRendererProps } from "../ToolCard";
import { ToolResultBody } from "./GenericRenderer";

/** The prose a note-like device write carries, whatever key its payload used. */
function noteText(args: Record<string, unknown>): string {
	for (const key of ["content", "plan", "text", "message", "body"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

/**
 * `xd://propose` and `xd://report_issue` (stock pi-tui `tools/resolve.ts`
 * describeResolutionDeviceCall, `tools/report-tool-issue.ts`): the device's
 * prose — a proposed plan as markdown, an issue report as text — then the
 * device's reply. Stock heads them "Propose" / "Report Tool Issue" with the
 * first line; the card header names the device and the body keeps the rest.
 */
export function DeviceNoteRenderer({
	args,
	result,
	isError,
	isPartial,
	markdown,
}: ToolRendererProps & { markdown?: boolean }) {
	const note = noteText(args);
	const reply = isPartial || result == null ? "" : resultText(result);
	return (
		<div className="flex flex-col gap-1.5" data-tool-device-note>
			{note &&
				(markdown ? (
					<div className="text-sc-sm">
						<MarkdownRenderer content={note} />
					</div>
				) : (
					<div className="whitespace-pre-wrap break-words text-sc-sm text-(--sc-text-secondary)">{note}</div>
				))}
			{reply.trim() && reply.trim() !== note.trim() && <ToolResultBody isError={isError} text={reply} />}
		</div>
	);
}
