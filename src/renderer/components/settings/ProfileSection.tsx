/**
 * Settings › General › Profile: how the agent addresses the user and how much
 * development background it assumes (prefs `userProfile`, contracts in
 * resources/gui-bridge/user-profile-contracts.ts). Main pushes a change to
 * every open local session, effective from its next turn; a tab on a paired
 * host follows the host's own setting, and the section says so.
 */

import { useEffect, useId, useRef, useState } from "react";
import {
	EXPERIENCE_LEVELS,
	type ExperienceLevel,
	normalizeUserProfile,
	USER_PROFILE_NAME_MAX,
	USER_PROFILE_PREF,
	type UserProfile,
} from "../../../../resources/gui-bridge/user-profile-contracts";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useFocusedHost } from "../../stores/remote";
import { toastError } from "../../stores/toast";
import { Input, Select } from "../common";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

export function ProfileSection() {
	const t = useT();
	const host = useFocusedHost();
	const nameId = useId();
	const experienceId = useId();
	const [profile, setProfile] = useState<UserProfile | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	// Edits apply at once and build on the latest one, so a level picked while
	// the name is still saving keeps that name; a failed write falls back to
	// the last value prefs accepted.
	const latest = useRef<UserProfile | null>(null);
	const saved = useRef<UserProfile | null>(null);

	useEffect(() => {
		let live = true;
		const loaded = (value: UserProfile) => {
			latest.current = value;
			saved.current = value;
			setProfile(value);
		};
		window.omp.prefs
			.get(USER_PROFILE_PREF)
			.then(stored => {
				if (live) loaded(normalizeUserProfile(stored));
			})
			.catch((error: unknown) => {
				if (!live) return;
				loaded(normalizeUserProfile(undefined));
				toastError({ title: t("settings.gui.profileLoadFailed"), error });
			});
		return () => {
			live = false;
		};
	}, [t]);

	const tooLong = draft !== null && draft.trim().length > USER_PROFILE_NAME_MAX;

	const save = (patch: Partial<UserProfile>) => {
		if (!latest.current) return;
		const next = { ...latest.current, ...patch };
		latest.current = next;
		setProfile(next);
		void saveGuiPreference(USER_PROFILE_PREF, next, () => {
			saved.current = next;
		}).then(ok => {
			if (ok || latest.current !== next) return;
			latest.current = saved.current;
			setProfile(saved.current);
		});
	};

	const commitName = () => {
		if (!latest.current || draft === null || tooLong) return;
		const name = draft.trim();
		setDraft(null);
		if (name !== latest.current.name) save({ name });
	};

	return (
		<SettingsSection title={t("settings.general.profile")}>
			<SettingsRow
				control={
					<Input
						autoComplete="nickname"
						disabled={profile === null}
						error={tooLong ? t("settings.gui.profileNameTooLong", { max: USER_PROFILE_NAME_MAX }) : undefined}
						id={nameId}
						onBlur={commitName}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") event.currentTarget.blur();
						}}
						placeholder={t("settings.gui.profileNamePlaceholder")}
						spellCheck={false}
						value={draft ?? profile?.name ?? ""}
					/>
				}
				description={t("settings.gui.profileNameDesc")}
				htmlFor={nameId}
				id="setting-gui-profileName"
				label={t("settings.gui.profileName")}
			/>
			<SettingsRow
				control={
					<Select
						disabled={profile === null}
						id={experienceId}
						onChange={event => {
							const value = event.target.value;
							const experience = (EXPERIENCE_LEVELS as readonly string[]).includes(value)
								? (value as ExperienceLevel)
								: null;
							save({ experience });
						}}
						options={[
							{ value: "", label: t("settings.gui.profileExperience.none") },
							...EXPERIENCE_LEVELS.map(value => ({
								value,
								label: t(`settings.gui.profileExperience.${value}`),
							})),
						]}
						value={profile?.experience ?? ""}
					/>
				}
				description={t("settings.gui.profileExperienceDesc")}
				footer={
					host && (
						<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)" data-profile-host="true">
							{t("settings.gui.replyLanguageHost", { name: host.name ?? t("remote.tab.unknownDevice") })}
						</p>
					)
				}
				htmlFor={experienceId}
				id="setting-gui-profileExperience"
				label={t("settings.gui.profileExperience")}
			/>
		</SettingsSection>
	);
}
