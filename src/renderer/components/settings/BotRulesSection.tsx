/**
 * Settings › Bot: the owner's action rules for the bot, stored whole in pref `botRules` (`shared/bot-rules.ts`). Each
 * rule is an action in the owner's words with what the bot does about it: without asking, only if pre-approved, ask
 * first, or hand the step to the owner. Add, edit and delete live here; a change is written before it is shown.
 *
 * Nothing stored reads as `DEFAULT_BOT_RULES`. A default rule is shown translated (`botRules.default.<id>`) while its
 * text is still the default; once the owner edits the words they are theirs, shown as written.
 */
import { MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	BOT_RULES_MAX,
	BOT_RULES_PREF,
	type BotRule,
	DEFAULT_BOT_RULES,
	isBotRuleBehavior,
	newBotRuleId,
	parseBotRules,
} from "../../../shared/bot-rules";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { readPref } from "../../lib/prefs-read";
import { Banner, Button, ConfirmDialog, MenuButton, Select, SkeletonRows } from "../common";
import { BotRuleDialog, type BotRuleDraft, botBehaviorOptions } from "./BotRuleDialog";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

/** What the list shows for a rule: the translation of an untouched default, else the owner's own text. */
function ruleLabel(rule: BotRule, t: (key: string) => string): string {
	const stock = DEFAULT_BOT_RULES.find(candidate => candidate.id === rule.id);
	return stock && stock.action === rule.action ? t(`botRules.default.${rule.id}`) : rule.action;
}

export function BotRulesSection() {
	const t = useT();
	const [rules, setRules] = useState<BotRule[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [editing, setEditing] = useState<{ rule: BotRule | null } | null>(null);
	const [deleting, setDeleting] = useState<BotRule | null>(null);
	// The list as last stored, and the writes in order: a second change starts from the first one's result.
	const stored = useRef<BotRule[] | null>(null);
	const queue = useRef<Promise<boolean>>(Promise.resolve(true));

	const load = useCallback(async () => {
		setLoadFailed(false);
		const read = await readPref(BOT_RULES_PREF);
		if (!read.ok) {
			setLoadFailed(true);
			return;
		}
		const next = parseBotRules(read.value);
		stored.current = next;
		setRules(next);
	}, []);
	useEffect(() => {
		void load();
		const unsubscribe = window.omp.prefs.onChanged?.(event => {
			if (event.key === BOT_RULES_PREF) void load();
		});
		return () => unsubscribe?.();
	}, [load]);

	const commit = (update: (current: BotRule[]) => BotRule[]): Promise<boolean> => {
		const run = async (): Promise<boolean> => {
			const current = stored.current;
			if (!current) return false;
			const next = update(current);
			return saveGuiPreference(BOT_RULES_PREF, next, () => {
				stored.current = next;
				setRules(next);
			});
		};
		const result = queue.current.then(run);
		queue.current = result;
		return result;
	};

	const save = async (draft: BotRuleDraft): Promise<boolean> => {
		const target = editing?.rule ?? null;
		const done = await commit(current => {
			if (!target) return [...current, { id: newBotRuleId(current), ...draft }];
			// Words left as the list showed them keep the stored text (an untouched default stays a default).
			const action = draft.action === ruleLabel(target, t) ? target.action : draft.action;
			return current.map(rule => (rule.id === target.id ? { ...rule, action, behavior: draft.behavior } : rule));
		});
		if (done) setEditing(null);
		return done;
	};

	if (!rules) {
		return (
			<SettingsSection>
				{loadFailed ? (
					<Banner
						actions={
							<Button icon={<RefreshCw />} onClick={() => void load()} size="sm">
								{t("common.retry")}
							</Button>
						}
						live
						title={t("botRules.loadFailed")}
						variant="danger"
					/>
				) : (
					<SkeletonRows label={t("botRules.loading")} widths={[60, 48, 66]} />
				)}
			</SettingsSection>
		);
	}

	const full = rules.length >= BOT_RULES_MAX;
	const options = botBehaviorOptions(t);
	return (
		<>
			<SettingsSection
				actions={
					<Button
						data-bot-rule-new
						disabled={full}
						icon={<Plus />}
						onClick={() => setEditing({ rule: null })}
						size="sm"
						title={full ? t("botRules.full") : undefined}
						variant="secondary"
					>
						{t("botRules.add")}
					</Button>
				}
				description={t("botRules.desc")}
				id="settings-bot-rules"
				title={t("botRules.title")}
			>
				{rules.length === 0 ? (
					<SettingsRow
						compactControl
						control={
							<Button
								data-bot-rules-restore
								onClick={() => void commit(() => DEFAULT_BOT_RULES.map(rule => ({ ...rule })))}
								size="sm"
								variant="secondary"
							>
								{t("botRules.restoreDefaults")}
							</Button>
						}
						id="settings-bot-rules-empty"
						label={<span className="text-(--sc-text-muted)">{t("botRules.empty")}</span>}
					/>
				) : (
					<div
						className="flex flex-col divide-y divide-(--sc-divider) border-t border-(--sc-divider)"
						data-bot-rules
					>
						{rules.map(rule => {
							const label = ruleLabel(rule, t);
							return (
								<SettingsRow
									control={
										<div className="flex items-center gap-1">
											<div className="w-44 min-w-0 flex-1">
												<Select
													aria-label={t("botRules.behaviorFor", { action: label })}
													controlSize="sm"
													data-bot-rule-behavior={rule.id}
													onChange={event => {
														const behavior = event.target.value;
														if (!isBotRuleBehavior(behavior)) return;
														void commit(current =>
															current.map(item => (item.id === rule.id ? { ...item, behavior } : item)),
														);
													}}
													options={options}
													value={rule.behavior}
												/>
											</div>
											<MenuButton
												align="end"
												icon={<MoreHorizontal />}
												items={[
													{
														id: "edit",
														label: t("botRules.edit"),
														icon: Pencil,
														onSelect: () => setEditing({ rule }),
													},
													{
														id: "delete",
														label: t("botRules.delete"),
														icon: Trash2,
														danger: true,
														onSelect: () => setDeleting(rule),
													},
												]}
												label={t("botRules.menu", { action: label })}
												size="sm"
											/>
										</div>
									}
									id={`settings-bot-rule-${rule.id}`}
									key={rule.id}
									label={<span data-bot-rule-action={rule.id}>{label}</span>}
								/>
							);
						})}
					</div>
				)}
			</SettingsSection>
			<BotRuleDialog
				initial={editing?.rule ? { action: ruleLabel(editing.rule, t), behavior: editing.rule.behavior } : null}
				onClose={() => setEditing(null)}
				onSave={save}
				open={editing !== null}
			/>
			<ConfirmDialog
				confirmLabel={t("botRules.delete")}
				message={t("botRules.deleteMessage", { action: deleting ? ruleLabel(deleting, t) : "" })}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const target = deleting;
					setDeleting(null);
					if (target) void commit(current => current.filter(rule => rule.id !== target.id));
				}}
				open={deleting !== null}
				title={t("botRules.deleteTitle")}
			/>
		</>
	);
}
