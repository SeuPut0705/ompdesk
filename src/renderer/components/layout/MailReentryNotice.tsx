/**
 * One notice, above the session, for the email accounts whose password this computer could not read because the
 * macOS keychain would have asked for the login password (native-rust › S › The keychain on macOS): it names every
 * such account once, and its action leads to the first account's password field in Settings › Schedules › Email
 * accounts. The accounts' routines do not log in meanwhile. A phone page shows it the same way (the action is its
 * glyph, the sentence keeps the row), exactly as `UpdateBanner` does.
 */
import { KeyRound } from "lucide-react";
import { useEffect } from "react";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import { useMailReentryAccounts, useMailReentryStore } from "../../stores/mail-reentry";
import { useUiStore } from "../../stores/ui";
import { Banner, Button, IconButton } from "../common";

export function MailReentryNotice() {
	const t = useT();
	const accounts = useMailReentryAccounts();
	const refresh = useMailReentryStore(state => state.refresh);
	const dismiss = useMailReentryStore(state => state.dismiss);
	const phone = useShellMode() === "phone";
	useEffect(() => {
		void refresh();
	}, [refresh]);
	if (accounts.length === 0) return null;
	const open = () => {
		useMailReentryStore.getState().requestEdit(accounts[0]?.id ?? "");
		useUiStore.getState().openSettings("schedules");
	};
	const names = accounts.map(account => account.label).join(", ");
	return (
		<div className="shrink-0 px-(--omp-column-pad) pt-1 pb-0.5" data-mail-reentry-notice>
			<Banner
				actions={
					phone ? (
						<IconButton icon={<KeyRound />} label={t("mail.reentry.action")} onClick={open} size="sm" />
					) : (
						<Button icon={<KeyRound />} onClick={open} size="sm" variant="ghost">
							{t("mail.reentry.action")}
						</Button>
					)
				}
				className="mx-auto max-w-(--omp-column-reading)"
				compact
				dismissLabel={t("mail.reentry.dismiss")}
				onDismiss={dismiss}
				role="status"
				variant="warning"
			>
				<span className={phone ? "line-clamp-4" : "line-clamp-2"}>
					{t(accounts.length === 1 ? "mail.reentry.one" : "mail.reentry.many", { names })}
				</span>
			</Banner>
		</div>
	);
}
