import { useState } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge } from "../common/Badge";
import { CustomMessageCard, workNoteSummary } from "./CustomMessageCard";

export function WorkNotes({ messages, live = false }: { messages: readonly AgentMessage[]; live?: boolean }) {
	const t = useT();
	const [showOlder, setShowOlder] = useState(false);
	const [expanded, setExpanded] = useState<string[]>([]);
	if (messages.length === 0) return null;
	const hidden = Math.max(0, messages.length - 2);
	const shown = showOlder ? messages : messages.slice(-2);
	return (
		<div className="omp-work-notes">
			{hidden > 0 && (
				<button
					type="button"
					className="omp-work-notes-more"
					aria-expanded={showOlder}
					onClick={() => setShowOlder(!showOlder)}
				>
					{showOlder ? t("chat.workNotes.less") : t("chat.workNotes.more", { count: hidden })}
				</button>
			)}
			<ul className="omp-work-notes-list" aria-label={t("chat.workNotes.label")}>
				{shown.map((message, index) => {
					const key =
						typeof message.id === "string"
							? message.id
							: `${String(message.timestamp)}-${showOlder ? index : index + hidden}`;
					const open = expanded.includes(key);
					const { Icon, source, body, severity, variant } = workNoteSummary(message);
					const label =
						source ??
						(message.customType === "advisor"
							? t("chat.custom.advisor")
							: message.customType === "async-result" || message.customType === "launch-completion"
								? t("chat.workNotes.job")
								: message.customType === "lsp-late-diagnostic"
									? t("chat.custom.lateDiagnostics")
									: message.customType === "skill-prompt"
										? t("chat.custom.skill")
										: message.customType === "handoff"
											? t("chat.custom.handoff")
											: t("chat.custom.prompt"));
					const age =
						message.timestamp == null
							? ""
							: formatTimeAgo(
									typeof message.timestamp === "number"
										? new Date(message.timestamp).toISOString()
										: message.timestamp,
								);
					return (
						<li
							key={key}
							className={live ? "omp-work-notes-item omp-work-notes-item--arriving" : "omp-work-notes-item"}
						>
							<button
								type="button"
								className="omp-work-notes-line"
								aria-expanded={open}
								onClick={() =>
									setExpanded(current => (open ? current.filter(value => value !== key) : [...current, key]))
								}
							>
								<Icon size={12} aria-hidden="true" />
								<span className="omp-work-notes-source">{label}</span>
								{message.customType === "advisor" && severity && <Badge variant={variant}>{severity}</Badge>}
								<span className="omp-work-notes-preview">{body.split(/\r?\n/)[0]}</span>
								{age && <span className="omp-work-notes-age">{age}</span>}
							</button>
							{open && <CustomMessageCard inProcess message={message} />}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
