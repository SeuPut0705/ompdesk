/**
 * Changelog window (/changelog): renders the GUI's own CHANGELOG.md through
 * the shared sanitized markdown pipeline. The markdown is embedded in the
 * renderer bundle via a `?raw` import, so packaged builds need no resource
 * resolution and the content is always in sync with the shipped version.
 *
 * After an update a quiet card offers the same window as "What's new" (`WhatsNewNotice` decides, the card is
 * `layout/WhatsNewCard`) with the running version's notes, or every release since the last seen one after
 * skipped updates; "All changes" widens it to the whole file.
 */

import { useEffect, useRef } from "react";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { useLang, useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import {
	changelogReleases,
	changelogSection,
	changelogSince,
	WHATS_NEW_PREF,
	whatsNewAction,
} from "../../lib/whats-new";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useSessionStore } from "../../stores/session";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { Button, Modal } from "../common";
import { useFirstRunActive } from "../onboarding/FirstRunSetup";

export function ChangelogDialog() {
	const t = useT();
	const open = useUiStore(state => state.changelogOpen);
	const version = useUiStore(state => state.changelogVersion);
	const since = useUiStore(state => state.changelogSince);
	const close = useUiStore(state => state.closeChangelog);
	const { lang } = useLang();
	const notes = version ? changelogSince(changelogMarkdown, since, version, lang) : null;
	return (
		<Modal
			footer={
				notes ? (
					<Button onClick={() => useUiStore.getState().openChangelog()} size="sm" variant="secondary">
						{t("whatsNew.allChanges")}
					</Button>
				) : undefined
			}
			onClose={close}
			open={open}
			size="lg"
			title={version && notes ? t("whatsNew.title", { version }) : t("changelog.title")}
		>
			{version && notes ? (
				<MarkdownRenderer content={notes} />
			) : (
				<MarkdownRenderer content={changelogReleases(changelogMarkdown, lang)} />
			)}
		</Modal>
	);
}

/**
 * Decides once per launch whether the update card shows (the card itself is `layout/WhatsNewCard`). It waits
 * for the session to be ready and for the machine-setup takeover, first-run setup and the getting-started
 * tour to leave the window, so the card never appears during them. Renders nothing.
 */
export function WhatsNewNotice() {
	const ready = useSessionStore(state => state.status) === "ready";
	const firstRunActive = useFirstRunActive();
	const takeover = useMachineSetupStore(state => state.takeover);
	const touring = useStarterGuideStore(state => state.tour !== null);
	const decided = useRef(false);

	useEffect(() => {
		if (!ready || firstRunActive || takeover || touring || decided.current) return;
		decided.current = true;
		void (async () => {
			const [seen, current] = await Promise.all([
				window.omp.prefs.get(WHATS_NEW_PREF),
				window.omp.updater.version(),
			]);
			const action = whatsNewAction(seen, current, changelogSection(changelogMarkdown, current) !== null);
			if (action === "record") await window.omp.prefs.set(WHATS_NEW_PREF, current);
			else if (action === "show" && typeof seen === "string") useUiStore.getState().showWhatsNewCard(current, seen);
		})().catch(() => {
			// A failed read decides nothing: the next launch asks again.
		});
	}, [firstRunActive, ready, takeover, touring]);

	return null;
}
