/**
 * Settings › Agent behavior › Suggestions: the built-in prompt suggestions
 * (prefs `nextPromptSuggestions`) and their sub-switch for inline completion
 * (`nextPromptInline`, only effective under the first). Main pushes a change
 * to every live local session; a paired host's tab follows the host's pref.
 * The cost note names the model the active tab's bridge last used, once known.
 */

import { Lightbulb, TextCursorInput } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
	NEXT_PROMPT_INLINE_PREF,
	NEXT_PROMPT_PREF,
} from "../../../../resources/gui-bridge/modes/next-prompt-contracts";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useMainPreference } from "./GeneralSection";
import { SettingsSwitchRow } from "./SettingsLayout";

export function NextPromptRow() {
	const t = useT();
	const [suggestions, setSuggestions] = useMainPreference(NEXT_PROMPT_PREF, true);
	const [inline, setInline] = useMainPreference(NEXT_PROMPT_INLINE_PREF, true);
	// Settings sits outside any tab runtime: follow the focused tab's bridge report.
	const state = useSyncExternalStore(
		useSessionStore.subscribe,
		() => useSessionStore.getState().nextPrompt,
		() => null,
	);
	return (
		<>
			<SettingsSwitchRow
				checked={suggestions}
				description={[
					t("settings.gui.nextPromptSuggestionsDesc"),
					t("settings.gui.nextPromptCost"),
					state?.model && t("settings.gui.nextPromptModel", { model: state.model.model }),
				]
					.filter(Boolean)
					.join(" ")}
				footer={
					state?.legacyExtension && (
						<p className="mt-1 text-sc-xs break-keep text-(--sc-text-muted)" data-next-prompt-legacy="true">
							{t("settings.gui.nextPromptLegacy")}
						</p>
					)
				}
				id="setting-gui-nextPromptSuggestions"
				icon={<Lightbulb />}
				label={t("settings.gui.nextPromptSuggestions")}
				onCheckedChange={setSuggestions}
			/>
			<div className="pl-4" data-next-prompt-inline="true">
				<SettingsSwitchRow
					checked={inline}
					description={t("settings.gui.nextPromptInlineDesc")}
					disabled={!suggestions}
					id="setting-gui-nextPromptInline"
					icon={<TextCursorInput />}
					label={t("settings.gui.nextPromptInline")}
					onCheckedChange={setInline}
				/>
			</div>
		</>
	);
}
