/**
 * The update notice: one quiet row in the shell's main column, between the title bar and the session
 * view (like the update-failure banner). It sits in the layout flow, so the workspace simply starts below it:
 * it never covers a pane's transcript, composer, Send, queue tray, goal dock or toasts (top-right), in a single
 * session, a split or with the side panel open (a sibling column). It is a polite live region and
 * focusable; Esc (focus inside it) dismisses.
 *
 * It stays until dismissed or opened, or until it has been on screen for `AUTO_HIDE_MS` of focused, unpaused
 * time: a card that vanished while the window sat unfocused would be a notice the user never saw. The version
 * counts as seen once the card is up (lib/whats-new), and the Help menu's "What's new" stays reachable.
 */

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useLang, useT } from "../../lib/i18n";
import {
	changelogSection,
	changelogSummary,
	endsWithFinalConsonant,
	useChangelog,
	WHATS_NEW_PREF,
} from "../../lib/whats-new";
import { useUiStore } from "../../stores/ui";
import { BrandMark, Button, IconButton } from "../common";

/** Focused, unhovered time before the card hides itself. */
export const WHATS_NEW_AUTO_HIDE_MS = 60_000;

function WhatsNewCardBody({ version, since }: { version: string; since: string | null }) {
	const t = useT();
	const { lang } = useLang();
	const paused = useRef(false);
	// Loaded already when WhatsNewNotice put the card up; the summary follows the title otherwise.
	const markdown = useChangelog();
	const summary = markdown === null ? "" : changelogSummary(changelogSection(markdown, version, lang) ?? "");
	const title = t(endsWithFinalConsonant(version) ? "whatsNew.cardTitle" : "whatsNew.cardTitleRo", { version });

	const open = () => useUiStore.getState().openWhatsNew(version, since);
	const dismiss = useUiStore(state => state.dismissWhatsNewCard);

	// On screen: this version counts as seen, so a relaunch does not show the card again.
	useEffect(() => {
		void window.omp.prefs.set(WHATS_NEW_PREF, version).catch(() => {});
	}, [version]);

	useEffect(() => {
		let visible = 0;
		const timer = setInterval(() => {
			if (paused.current) return;
			if (typeof document.hasFocus === "function" && !document.hasFocus()) return;
			visible += 1000;
			if (visible >= WHATS_NEW_AUTO_HIDE_MS) dismiss();
		}, 1000);
		return () => clearInterval(timer);
	}, [dismiss]);

	return (
		<div className="shrink-0 px-(--omp-column-pad) pt-2">
			<section
				aria-label={title}
				className="omp-whats-new-card mx-auto flex max-w-(--omp-column-reading) items-center gap-2 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) py-1 pr-1 pl-2.5 text-sc-sm"
				data-whats-new-card
				onBlur={event => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) paused.current = false;
				}}
				onClick={event => {
					if (!(event.target as Element).closest("button")) open();
				}}
				onFocus={() => {
					paused.current = true;
				}}
				onKeyDown={event => {
					if (event.key === "Escape") {
						event.stopPropagation();
						dismiss();
					} else if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
						event.preventDefault();
						open();
					}
				}}
				onMouseEnter={() => {
					paused.current = true;
				}}
				onMouseLeave={() => {
					paused.current = false;
				}}
				tabIndex={0}
			>
				<BrandMark size={16} />
				<span className="min-w-0 truncate font-semibold text-(--sc-text)" title={title}>
					{title}
				</span>
				{summary && (
					<span
						className="min-w-0 flex-1 truncate text-(--sc-text-secondary)"
						data-whats-new-summary
						title={summary}
					>
						{summary}
					</span>
				)}
				<Button className="ml-auto shrink-0" data-whats-new-details onClick={open} size="sm" variant="ghost">
					{t("whatsNew.details")}
				</Button>
				<IconButton className="shrink-0" icon={<X />} label={t("common.close")} onClick={dismiss} size="sm" />
			</section>
		</div>
	);
}

/** Mounted once in the shell's main column under the title bar; renders the card while the ui store holds one. */
export function WhatsNewCard() {
	const card = useUiStore(state => state.whatsNewCard);
	return (
		<div aria-atomic="true" aria-live="polite" className="shrink-0" role="status">
			{card && <WhatsNewCardBody key={card.version} since={card.since} version={card.version} />}
		</div>
	);
}
