import { MousePointer2 } from "lucide-react";
import { parseComputerUseNotice } from "../../../../resources/gui-bridge/modes/computer-use-contracts";
import type { AgentMessage } from "../../../shared/rpc-types";
import { resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";

/** A connect failure is one line of stock's text; a longer one stays whole in the hover title. */
const ERROR_SHOWN_CHARS = 160;

/**
 * A session that wanted agent-desktop and fell back to the built-in computer use says so once, in its transcript
 * (bridge custom message `ompdesk-computer-use`, resources/gui-bridge/modes/computer-use-contracts.ts): one small
 * muted line with the reason (not installed, or the server did not start and why) and where to change the engine.
 * Display only; the model never reads it.
 */
export function ComputerUseNote({ message }: { message: AgentMessage }) {
	const t = useT();
	const notice = parseComputerUseNotice(resultDetails(message));
	if (!notice) return null;
	const error = notice.error ?? "";
	const reason =
		notice.reason === "missing"
			? t("chat.computerUse.missing")
			: error
				? t("chat.computerUse.failed", {
						error: error.length > ERROR_SHOWN_CHARS ? `${error.slice(0, ERROR_SHOWN_CHARS)}…` : error,
					})
				: t("chat.computerUse.failedBare");
	return (
		<div
			className="omp-computer-use-note flex items-start gap-2 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1.5 text-sc-sm text-(--sc-text-subtle)"
			data-computer-use-note={notice.reason}
			title={error || undefined}
		>
			<MousePointer2 aria-hidden className="mt-0.5 size-(--sc-icon-sm) shrink-0" />
			<span className="min-w-0">
				{t("chat.computerUse.fallback")} {reason} {t("chat.computerUse.hint")}
			</span>
		</div>
	);
}
