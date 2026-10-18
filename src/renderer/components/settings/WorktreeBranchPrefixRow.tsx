/**
 * Settings › Project folders › Worktree branch prefix (C82): what new worktree
 * branches start with, for worktree tabs and for session worktrees
 * (`worktree.onStart`). Empty keeps the defaults (omp/gui/ and stock's wt/).
 * Saved when the field loses focus or on Enter, only when git would accept it.
 */
import { GitBranch } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	GUI_WORKTREE_BRANCH_PREFIX,
	WORKTREE_BRANCH_PREFIX_MAX,
	WORKTREE_BRANCH_PREFIX_PREF,
	worktreeBranchPrefix,
} from "../../../shared/worktree-branch";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { Input } from "../common";
import { SettingsRow } from "./SettingsLayout";

export function WorktreeBranchPrefixRow() {
	const t = useT();
	const id = useId();
	const [saved, setSaved] = useState("");
	const [draft, setDraft] = useState("");
	useEffect(() => {
		let live = true;
		// Started inside a promise so a missing prefs API (tests) leaves the field empty.
		void Promise.resolve()
			.then(() => window.omp.prefs.get(WORKTREE_BRANCH_PREFIX_PREF))
			.then(
				stored => {
					if (!live) return;
					const value = worktreeBranchPrefix(stored) ?? "";
					setSaved(value);
					setDraft(value);
				},
				() => undefined,
			);
		return () => {
			live = false;
		};
	}, []);
	const trimmed = draft.trim();
	const valid = trimmed === "" || worktreeBranchPrefix(trimmed) !== null;
	const commit = () => {
		if (!valid || trimmed === saved) return;
		void saveGuiPreference(WORKTREE_BRANCH_PREFIX_PREF, trimmed, () => {
			setSaved(trimmed);
			setDraft(trimmed);
		});
	};
	const examplePrefix = valid && trimmed ? trimmed : GUI_WORKTREE_BRANCH_PREFIX;
	return (
		<SettingsRow
			control={
				<Input
					aria-describedby={`${id}-example`}
					error={valid ? undefined : t("settings.worktreeBranchPrefix.invalid")}
					id={id}
					maxLength={WORKTREE_BRANCH_PREFIX_MAX}
					mono
					onBlur={commit}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") commit();
						if (event.key === "Escape") setDraft(saved);
					}}
					placeholder={GUI_WORKTREE_BRANCH_PREFIX}
					spellCheck={false}
					value={draft}
				/>
			}
			description={
				<>
					{t("settings.worktreeBranchPrefix.desc")}{" "}
					<span id={`${id}-example`}>
						{t("settings.worktreeBranchPrefix.example", { branch: `${examplePrefix}fix-login` })}
					</span>
				</>
			}
			htmlFor={id}
			id="setting-gui-worktreeBranchPrefix"
			icon={<GitBranch />}
			label={t("settings.worktreeBranchPrefix")}
		/>
	);
}
