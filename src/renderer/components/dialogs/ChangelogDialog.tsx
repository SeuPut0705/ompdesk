/**
 * Changelog window (/changelog): renders the GUI's own CHANGELOG.md through
 * the shared sanitized markdown pipeline. The markdown is embedded in the
 * renderer bundle via a `?raw` import, so packaged builds need no resource
 * resolution and the content is always in sync with the shipped version.
 *
 * After an update the same window opens once as "What's new" with only the
 * running version's section (`WhatsNewNotice`); "All changes" widens it to
 * the whole file.
 */

import { useEffect, useRef } from "react";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { useLang, useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { changelogReleases, changelogSection, WHATS_NEW_PREF, whatsNewAction } from "../../lib/whats-new";
import { useSessionStore } from "../../stores/session";
import { useStarterGuideStore } from "../../stores/starter-guide";
import { useUiStore } from "../../stores/ui";
import { Button, Modal } from "../common";
import { useFirstRunActive } from "../onboarding/FirstRunSetup";

/** Mounted only inside the open notice: the version counts as seen once it is on screen. */
function SeenMark({ version }: { version: string }) {
	useEffect(() => {
		void window.omp.prefs.set(WHATS_NEW_PREF, version).catch(() => {});
	}, [version]);
	return null;
}

export function ChangelogDialog() {
	const t = useT();
	const open = useUiStore(state => state.changelogOpen);
	const version = useUiStore(state => state.changelogVersion);
	const close = useUiStore(state => state.closeChangelog);
	const { lang } = useLang();
	const notes = version ? changelogSection(changelogMarkdown, version, lang) : null;
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
				<>
					<SeenMark version={version} />
					<MarkdownRenderer content={notes} />
				</>
			) : (
				<MarkdownRenderer content={changelogReleases(changelogMarkdown, lang)} />
			)}
		</Modal>
	);
}

/**
 * Opens "What's new" once after an update. It waits for the session to be
 * ready and for first-run setup and the getting-started tour to leave the
 * window, then decides once per launch. Renders nothing.
 */
export function WhatsNewNotice() {
	const ready = useSessionStore(state => state.status) === "ready";
	const firstRunActive = useFirstRunActive();
	const touring = useStarterGuideStore(state => state.tour !== null);
	const decided = useRef(false);

	useEffect(() => {
		if (!ready || firstRunActive || touring || decided.current) return;
		decided.current = true;
		void (async () => {
			const [seen, current] = await Promise.all([
				window.omp.prefs.get(WHATS_NEW_PREF),
				window.omp.updater.version(),
			]);
			const action = whatsNewAction(seen, current, changelogSection(changelogMarkdown, current) !== null);
			if (action === "record") await window.omp.prefs.set(WHATS_NEW_PREF, current);
			else if (action === "show") useUiStore.getState().openWhatsNew(current);
		})().catch(() => {
			// A failed read decides nothing: the next launch asks again.
		});
	}, [firstRunActive, ready, touring]);

	return null;
}
