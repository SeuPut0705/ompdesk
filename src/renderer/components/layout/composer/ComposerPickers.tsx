/**
 * The pickers that open over the composer: the ⌃R prompt-history search and the + menu's skill picker. Each
 * hands focus back to the field when it closes.
 */
import type { RefObject } from "react";
import type { AvailableCommand } from "../../../../shared/rpc-types";
import { useUiStore } from "../../../stores/ui";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { SkillPickerOverlay } from "./SkillPickerOverlay";

export function ComposerPickers({
	historyOpen,
	skillsOpen,
	cwd,
	commands,
	textareaRef,
	closeHistory,
	closeSkills,
	onPickHistory,
	onPickSkill,
}: {
	historyOpen: boolean;
	skillsOpen: boolean;
	cwd: string;
	/** The tab's commands; the `skill:` ones are the skills offered. */
	commands: readonly AvailableCommand[];
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	closeHistory: () => void;
	closeSkills: () => void;
	/** A history entry was picked (the picker already closed and focused the field). */
	onPickHistory: (prompt: string) => void;
	/** A skill was picked (the picker already closed and focused the field). */
	onPickSkill: (name: string) => void;
}) {
	const openSettings = useUiStore(s => s.openSettings);
	return (
		<>
			{historyOpen && (
				<HistorySearchOverlay
					cwd={cwd}
					onSelect={prompt => {
						closeHistory();
						textareaRef.current?.focus();
						onPickHistory(prompt);
					}}
					onClose={() => {
						closeHistory();
						requestAnimationFrame(() => textareaRef.current?.focus());
					}}
				/>
			)}
			{skillsOpen && (
				<SkillPickerOverlay
					skills={commands
						.filter(command => command.name.startsWith("skill:"))
						.map(command => ({
							name: command.name.slice("skill:".length),
							description: command.description ?? "",
						}))
						.sort((a, b) => a.name.localeCompare(b.name))}
					onClose={() => {
						closeSkills();
						requestAnimationFrame(() => textareaRef.current?.focus());
					}}
					onManage={() => {
						closeSkills();
						openSettings("tools:skills");
					}}
					onSelect={name => {
						closeSkills();
						textareaRef.current?.focus();
						onPickSkill(name);
					}}
				/>
			)}
		</>
	);
}
