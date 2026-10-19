import { Clock } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";

/**
 * Reports from other sessions (`ompdesk_report` progress or note) this tab's bridge holds while its turn runs: one
 * quiet waiting line each under the transcript, in the shape of the `MailNote` it becomes once the turn ends and
 * stock journals it (the `mail_pending` frame then lists none). Nothing to open yet: the text arrives with the note.
 */
export function PendingMailNotes() {
	const t = useT();
	const items = useSessionStore(s => s.pendingMail);
	if (items.length === 0) return null;
	return (
		<div className="omp-custom-turn flex-col ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1">
			{items.map(item => (
				<div
					key={item.id}
					className="flex min-h-7 max-w-full min-w-0 items-center gap-1.5 px-1 text-sc-sm text-(--sc-text-subtle)"
					data-agent-mail-pending={item.kind}
				>
					<Clock aria-hidden className="size-(--sc-icon-sm) shrink-0" />
					<span className="min-w-0 truncate font-medium">{t("chat.custom.mail", { from: item.from || "?" })}</span>
					<span aria-hidden>·</span>
					<span className="shrink-0">{t(`chat.custom.mail.kind.${item.kind}`)}</span>
					<span aria-hidden>·</span>
					<span className="shrink-0">{t("chat.custom.mail.pending")}</span>
				</div>
			))}
		</div>
	);
}
