/**
 * Add or edit one of the bot's action rules (Settings › Bot): the action in the owner's words and what the bot does
 * about it. The text is cleaned the way `parseBotRules` reads it back, so what is saved is what is shown.
 */
import { useEffect, useId, useState } from "react";
import {
	BOT_RULE_ACTION_MAX,
	BOT_RULE_BEHAVIORS,
	type BotRuleBehavior,
	cleanBotRuleAction,
	isBotRuleBehavior,
} from "../../../shared/bot-rules";
import { useT } from "../../lib/i18n";
import { Button, Input, Modal, Select, type SelectOption } from "../common";

/** The four behaviors as Select options, in the order the owner reads them (most to least independent). */
export function botBehaviorOptions(t: (key: string) => string): SelectOption[] {
	return BOT_RULE_BEHAVIORS.map(value => ({ value, label: t(`botRules.behavior.${value}`) }));
}

export interface BotRuleDraft {
	action: string;
	behavior: BotRuleBehavior;
}

export function BotRuleDialog({
	open,
	initial,
	onClose,
	onSave,
}: {
	open: boolean;
	/** The rule to edit, its text as the list shows it; null adds one. */
	initial: BotRuleDraft | null;
	onClose: () => void;
	/** Resolves true once the rule is stored; false keeps the dialog open (the failure is already shown). */
	onSave: (draft: BotRuleDraft) => Promise<boolean>;
}) {
	const t = useT();
	const formId = useId();
	const [action, setAction] = useState("");
	const [behavior, setBehavior] = useState<BotRuleBehavior>("ask");
	const [touched, setTouched] = useState(false);
	const [saving, setSaving] = useState(false);
	// Each opening starts from the rule it edits, or a blank one that asks first.
	useEffect(() => {
		if (!open) return;
		setAction(initial?.action ?? "");
		setBehavior(initial?.behavior ?? "ask");
		setTouched(false);
	}, [open, initial]);

	const cleaned = cleanBotRuleAction(action);
	const submit = async () => {
		setTouched(true);
		if (cleaned === "") return;
		setSaving(true);
		try {
			await onSave({ action: cleaned, behavior });
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button form={formId} loading={saving} type="submit" variant="primary">
						{initial ? t("botRules.save") : t("botRules.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="sm"
			title={initial ? t("botRules.dialog.edit") : t("botRules.dialog.new")}
		>
			<form
				className="flex flex-col gap-4"
				data-bot-rule-form
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					autoFocus
					error={touched && cleaned === "" ? t("botRules.problem.action") : undefined}
					hint={t("botRules.field.actionHint")}
					label={t("botRules.field.action")}
					maxLength={BOT_RULE_ACTION_MAX}
					onChange={event => setAction(event.target.value)}
					placeholder={t("botRules.field.actionPlaceholder")}
					value={action}
				/>
				<Select
					label={t("botRules.field.behavior")}
					onChange={event => {
						if (isBotRuleBehavior(event.target.value)) setBehavior(event.target.value);
					}}
					options={botBehaviorOptions(t)}
					value={behavior}
				/>
			</form>
		</Modal>
	);
}
