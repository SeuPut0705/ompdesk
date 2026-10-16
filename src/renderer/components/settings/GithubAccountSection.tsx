/**
 * Settings › General › GitHub account: the GitHub CLI login on this computer
 * (shared with the user's terminal), signed in, out or switched without one,
 * and the Git commit identity it fills in. Sits next to "This computer".
 */

import { useT } from "../../lib/i18n";
import { GithubSignIn } from "../onboarding/GithubSignIn";
import { SettingsSection } from "./SettingsLayout";

export function GithubAccountSection() {
	const t = useT();
	return (
		<SettingsSection
			description={t("githubAuth.settings.description")}
			id="setting-github-account"
			title={t("githubAuth.settings.title")}
		>
			<div className="settings-row min-w-0 py-2">
				<GithubSignIn framed={false} />
			</div>
		</SettingsSection>
	);
}
