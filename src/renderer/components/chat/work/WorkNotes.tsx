import { useState } from "react";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { formatAgo, formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Badge } from "../../common/Badge";
import { Collapse } from "../../common/Collapse";
import { LinkButton } from "../../common/LinkButton";
import { advisorSeverityLabel, CustomMessageCard, workNoteSummary } from "../CustomMessageCard";
import { TodoReminderNote } from "../TodoReminderNote";
import { parseTodoReminder } from "../todo-reminder";
import { useRestartCuts } from "./use-restart-cuts";

export function WorkNotes({ messages, live = false }: { messages: readonly AgentMessage[]; live?: boolean }) {
	const t = useT();
	const [showOlder, setShowOlder] = useState(false);
	const [expanded, setExpanded] = useState<string[]>([]);
	const cuts = useRestartCuts();
	if (messages.length === 0) return null;
	const folded = showOlder ? [] : messages.slice(0, -2);
	const hidden = folded.length;
	const shown = messages.slice(hidden);
	return (
		<div className="omp-work-notes">
			{hidden > 0 && (
				<LinkButton
					tone="muted"
					className="omp-work-notes-more"
					aria-expanded={showOlder}
					onClick={() => setShowOlder(!showOlder)}
				>
					{showOlder ? t("chat.workNotes.less") : t("chat.workNotes.more", { count: hidden })}
				</LinkButton>
			)}
			<ul className="omp-work-notes-list" aria-label={t("chat.workNotes.label")}>
				{shown.map(message => {
					const index = messages.indexOf(message);
					const key = typeof message.id === "string" ? message.id : `${String(message.timestamp)}-${index}`;
					const itemClass = live ? "omp-work-notes-item omp-work-notes-item--arriving" : "omp-work-notes-item";
					const reminder = parseTodoReminder(message);
					if (reminder)
						return (
							<li key={key} className={itemClass}>
								<TodoReminderNote message={message} reminder={reminder} />
							</li>
						);
					const open = expanded.includes(key);
					const { Icon, source, body, severity, variant, failed, interrupted } = workNoteSummary(
						message,
						cuts.deliveries.get(message),
					);
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
					const age = formatAgo(message.timestamp);
					return (
						<li key={key} className={itemClass}>
							{/* controls-ok: the omp-work-notes-line class draws the whole control */}
							<button
								type="button"
								className="omp-work-notes-line"
								aria-expanded={open}
								onClick={() =>
									setExpanded(current => (open ? current.filter(value => value !== key) : [...current, key]))
								}
							>
								<Icon size={12} aria-hidden="true" className={failed ? "omp-work-notes-failed" : undefined} />
								<span className="omp-work-notes-source">{label}</span>
								{message.customType === "advisor" && severity && (
									<Badge variant={variant}>{advisorSeverityLabel(severity, t)}</Badge>
								)}
								<span className="omp-work-notes-preview">
									{(interrupted && !body ? t("chat.work.cutByRestart") : body).split(/\r?\n/)[0]}
								</span>
								{age && (
									<time
										className="omp-work-notes-age"
										dateTime={new Date(message.timestamp ?? 0).toISOString()}
										title={formatClock(message.timestamp)}
									>
										{age}
									</time>
								)}
							</button>
							<Collapse className="flow-root" open={open}>
								<CustomMessageCard inProcess message={message} />
							</Collapse>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
