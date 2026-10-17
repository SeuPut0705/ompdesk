/**
 * The update notice: one compact card in the bottom-right corner of the active session pane, directly above
 * the composer region (so it never covers the composer or Send) and left of the work board; the side panel is
 * a sibling of the pane, so it is clear of that too. Top-right belongs to the toast stack, so the two never
 * overlap. It is a polite live region and focusable; Esc (focus inside it) dismisses.
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
		<section
			aria-label={title}
			className="omp-whats-new-card flex items-start gap-2.5 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) py-3 pr-2 pl-3 shadow-(--sc-shadow-md)"
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
			<BrandMark className="mt-0.5" size={18} />
			<div className="min-w-0 flex-1 py-px">
				<div className="mb-0.5 text-sc-sm font-semibold break-words break-keep text-(--sc-text)">{title}</div>
				{summary && (
					<div
						className="line-clamp-2 text-sc-sm break-words break-keep text-(--sc-text-secondary)"
						data-whats-new-summary
					>
						{summary}
					</div>
				)}
				<Button className="mt-2" data-whats-new-details onClick={open} size="sm" variant="secondary">
					{t("whatsNew.details")}
				</Button>
			</div>
			<IconButton className="-my-1 shrink-0" icon={<X />} label={t("common.close")} onClick={dismiss} size="sm" />
		</section>
	);
}

/** Mounted in the active session pane's composer region; renders the card while the ui store holds one. */
export function WhatsNewCard() {
	const card = useUiStore(state => state.whatsNewCard);
	return (
		<div aria-atomic="true" aria-live="polite" className="omp-whats-new-slot" role="status">
			{card && <WhatsNewCardBody key={card.version} since={card.since} version={card.version} />}
		</div>
	);
}
