import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { formatAgo, formatClock } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { messageDisplayText } from "../../../lib/messages";
import { Badge } from "../../common/Badge";
import { LinkButton } from "../../common/LinkButton";
import { advisorSeverityLabel, CustomMessageCard, workNoteSummary } from "../CustomMessageCard";
import { TodoReminderNote } from "../TodoReminderNote";
import { parseTodoReminder } from "../todo-reminder";

/** A steer the user sent into this run (stock delivers it as a `steering` user message). */
function isRunSteer(message: AgentMessage) {
	return message.role === "user";
}

export function WorkNotes({ messages, live = false }: { messages: readonly AgentMessage[]; live?: boolean }) {
	const t = useT();
	const [showOlder, setShowOlder] = useState(false);
	const [expanded, setExpanded] = useState<string[]>([]);
	if (messages.length === 0) return null;
	// Only agent/advisor notices fold behind "more": the user's own steers always stay in view.
	const notices = messages.filter(message => !isRunSteer(message));
	const folded = showOlder ? [] : notices.slice(0, -2);
	const hidden = folded.length;
	const shown = messages.filter(message => !folded.includes(message));
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
					if (isRunSteer(message)) {
						const text = messageDisplayText(message).trim();
						const time = formatAgo(message.timestamp);
						return (
							<li key={key} className={`${itemClass} omp-work-steer`} data-steer>
								<CornerDownRight size={12} aria-hidden="true" className="omp-work-steer-icon" />
								<span className="omp-work-steer-label">{t("chat.steering")}</span>
								<span className="omp-work-steer-text" title={text}>
									{text}
								</span>
								{time && (
									<time
										className="omp-work-notes-age"
										dateTime={new Date(message.timestamp ?? 0).toISOString()}
										title={formatClock(message.timestamp)}
									>
										{time}
									</time>
								)}
							</li>
						);
					}
					const reminder = parseTodoReminder(message);
					if (reminder)
						return (
							<li key={key} className={itemClass}>
								<TodoReminderNote message={message} reminder={reminder} />
							</li>
						);
					const open = expanded.includes(key);
					const { Icon, source, body, severity, variant, failed } = workNoteSummary(message);
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
								<span className="omp-work-notes-preview">{body.split(/\r?\n/)[0]}</span>
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
							{open && <CustomMessageCard inProcess message={message} />}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
