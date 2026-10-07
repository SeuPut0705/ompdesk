/**
 * Agents › Definitions › agent editor (Sheet lg): create, duplicate or edit a
 * task-agent definition file. Every frontmatter key omp reads has a field;
 * the body is the agent's instructions (CodeMirror markdown, loaded lazily).
 * Saving serializes over the original file (unknown keys and comments kept)
 * and writes through the main process, which refuses paths outside the user
 * and project agent directories and never replaces another agent's file.
 */

import { ArrowDown, ArrowUp, Check, ExternalLink, FolderOpen, X } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import {
	AGENT_THINKING_LEVELS,
	type AgentDraft,
	type AgentNameNotice,
	agentFileName,
	checkAgentName,
	draftErrors,
	READ_ONLY_TOOLS,
	serializeAgentMarkdown,
} from "../../../shared/agent-definition";
import type { AgentFileScope, RpcAgentDefinitionInfo } from "../../../shared/rpc-types";
import { errorMessage } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { toastError } from "../../stores/toast";
import {
	Banner,
	Button,
	ErrorDetail,
	IconButton,
	Input,
	MenuButton,
	Select,
	Sheet,
	Spinner,
	SwitchField,
	Tabs,
	TextArea,
} from "../common";
import { ModelValueSelect } from "../settings/ModelValueSelect";
import { type AgentAuthoringData, useAgentAuthoring } from "./agent-authoring";
import { MarkdownEditor } from "./MarkdownEditor";

export type AgentEditorTarget =
	| {
			mode: "create";
			draft: AgentDraft;
			scope: AgentFileScope;
			/** File text the draft came from (Duplicate): its unknown keys and comments carry over. */
			original?: string;
	  }
	| {
			mode: "edit";
			draft: AgentDraft;
			scope: AgentFileScope;
			original: string;
			filePath: string;
			/** The frontmatter could not be read; saving rewrites it. */
			parseError?: string;
	  };

export interface AgentEditorSheetProps {
	/** `null` closes the sheet. Changing the object resets the form. */
	target: AgentEditorTarget | null;
	definitions: readonly RpcAgentDefinitionInfo[];
	onClose: () => void;
	onSaved: (saved: { name: string; filePath: string }) => void;
}

/** Join an omp-reported directory and a file name with the directory's own separator. */
export function joinAgentPath(dir: string, file: string): string {
	const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	return dir.endsWith(separator) ? `${dir}${file}` : `${dir}${separator}${file}`;
}

export async function revealAgentFile(filePath: string, action: "open" | "reveal", failedTitle: string) {
	const result =
		action === "open" ? await window.omp.system.openPath(filePath) : await window.omp.system.revealPath(filePath);
	if (!result.ok) toastError({ title: failedTitle, error: result.error ? result : filePath });
}

export function AgentEditorSheet({ target, definitions, onClose, onSaved }: AgentEditorSheetProps) {
	const t = useT();
	const formId = useId();
	const [saving, setSaving] = useState(false);
	// Keep rendering the last target while the sheet animates out, and give
	// every newly opened target a fresh form (its state seeds from the draft).
	const lastTarget = useRef(target);
	const formKey = useRef(0);
	if (target && target !== lastTarget.current) formKey.current += 1;
	if (target) lastTarget.current = target;
	const shown = target ?? lastTarget.current;
	const authoring = useAgentAuthoring(target !== null);
	const title = !shown
		? ""
		: shown.mode === "edit"
			? t("agentStudio.editor.titleEdit", { name: shown.draft.name })
			: t("agentStudio.editor.titleNew");
	return (
		<Sheet
			description={t("agentStudio.editor.description")}
			footer={
				<>
					<Button disabled={saving} onClick={onClose} variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button disabled={!authoring.data} form={formId} loading={saving} type="submit" variant="primary">
						{shown?.mode === "edit" ? t("common.save") : t("agentStudio.save.create")}
					</Button>
				</>
			}
			onClose={onClose}
			open={target !== null}
			size="lg"
			title={title}
		>
			{shown &&
				(authoring.data ? (
					<AgentEditorForm
						key={formKey.current}
						data={authoring.data}
						definitions={definitions}
						formId={formId}
						onSaved={onSaved}
						onSavingChange={setSaving}
						target={shown}
					/>
				) : authoring.error ? (
					<Banner
						actions={
							<Button onClick={authoring.reload} size="sm" variant="secondary">
								{t("agentHub.retry")}
							</Button>
						}
						title={t("agentStudio.editor.loadFailed")}
						variant="danger"
					>
						{authoring.error}
					</Banner>
				) : (
					<div className="flex justify-center py-12">
						<Spinner label={t("common.loading")} />
					</div>
				))}
		</Sheet>
	);
}

type PatternMode = "off" | "on" | "custom";

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-4 border-t border-(--sc-divider) pt-5 first:border-t-0 first:pt-0">
			<h3 className="text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase">{title}</h3>
			{children}
		</section>
	);
}

/** A labelled group of toggle chips (tools, skills, spawnable agents). */
function ChipGroup({
	label,
	hint,
	options,
	selected,
	onToggle,
	actions,
}: {
	label: string;
	hint?: ReactNode;
	options: readonly string[];
	selected: readonly string[];
	onToggle: (option: string) => void;
	actions?: ReactNode;
}) {
	const labelId = useId();
	const all = [...options, ...selected.filter(option => !options.includes(option))];
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sc-sm font-medium text-(--sc-text-secondary)" id={labelId}>
					{label}
				</span>
				{actions}
			</div>
			<div aria-labelledby={labelId} className="flex flex-wrap gap-1.5" role="group">
				{all.map(option => {
					const on = selected.includes(option);
					return (
						<Button
							aria-pressed={on}
							icon={on ? <Check /> : undefined}
							key={option}
							onClick={() => onToggle(option)}
							size="sm"
							variant={on ? "secondary" : "ghost"}
						>
							{option}
						</Button>
					);
				})}
			</div>
			{hint && <p className="text-sc-sm text-(--sc-text-muted)">{hint}</p>}
		</div>
	);
}

/** A frontmatter key that is off (absent), on (`true`) or an explicit model pattern (prewalk, advisor). */
function PatternField({
	label,
	description,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	description: string;
	value: boolean | string;
	onChange: (value: boolean | string) => void;
	placeholder: string;
}) {
	const t = useT();
	const [mode, setMode] = useState<PatternMode>(
		value === false || value === "" ? "off" : value === true ? "on" : "custom",
	);
	const pattern = typeof value === "string" ? value : "";
	return (
		<div className="flex flex-col gap-2">
			<Select
				hint={description}
				label={label}
				onChange={event => {
					const next = event.target.value as PatternMode;
					setMode(next);
					onChange(next === "off" ? false : next === "on" ? true : pattern);
				}}
				options={[
					{ value: "off", label: t("agentStudio.pattern.off") },
					{ value: "on", label: t("agentStudio.pattern.on") },
					{ value: "custom", label: t("agentStudio.pattern.custom") },
				]}
				value={mode}
			/>
			{mode === "custom" && (
				<Input
					aria-label={t("agentStudio.pattern.inputLabel", { field: label })}
					hint={t("agentStudio.pattern.inputHint")}
					mono
					onChange={event => onChange(event.target.value)}
					placeholder={placeholder}
					spellCheck={false}
					value={pattern}
				/>
			)}
		</div>
	);
}

type SpawnsMode = "none" | "all" | "custom";

function AgentEditorForm({
	target,
	data,
	definitions,
	formId,
	onSaved,
	onSavingChange,
}: {
	target: AgentEditorTarget;
	data: AgentAuthoringData;
	definitions: readonly RpcAgentDefinitionInfo[];
	formId: string;
	onSaved: (saved: { name: string; filePath: string }) => void;
	onSavingChange: (saving: boolean) => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const [draft, setDraft] = useState<AgentDraft>(target.draft);
	const [scope, setScope] = useState<AgentFileScope>(target.scope);
	const [spawnsMode, setSpawnsMode] = useState<SpawnsMode>(
		target.draft.spawns === "*" ? "all" : target.draft.spawns.length > 0 ? "custom" : "none",
	);
	const [submitted, setSubmitted] = useState(false);
	/** Localized sentence for the banner body; `cause` is the raw failure shown under it. */
	const [saveError, setSaveError] = useState<{ message: string; cause?: unknown } | null>(null);
	const errorRef = useRef<HTMLDivElement>(null);
	const instructionsHintId = useId();
	const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
		setDraft(current => ({ ...current, [key]: value }));
	const toggleIn = (list: readonly string[], item: string) =>
		list.includes(item) ? list.filter(entry => entry !== item) : [...list, item];

	const selfPath = target.mode === "edit" ? target.filePath : undefined;
	const nameCheck = useMemo(
		() => checkAgentName(draft.name, scope, definitions, selfPath),
		[draft.name, scope, definitions, selfPath],
	);
	const errors = draftErrors(draft, nameCheck);
	// Before the first save attempt only problems in what was typed show; "required" waits.
	const visibleErrors = submitted
		? errors
		: {
				...(errors.name && errors.name !== "required" ? { name: errors.name } : {}),
				...(errors.output ? { output: errors.output } : {}),
			};
	const fileName = agentFileName(draft.name.trim() || t("agentStudio.editor.namePlaceholder"));
	const targetPath = joinAgentPath(data.info.dirs[scope], fileName);
	const agentNames = definitions.map(definition => definition.name).filter(name => name !== draft.name.trim());
	const roleByValue = new Map(data.roles.map(role => [role.value, role]));

	const noticeText = (notice: AgentNameNotice) =>
		t(`agentStudio.name.notice.${notice.kind}`, { name: draft.name.trim() });

	const moveModel = (index: number, delta: number) => {
		const next = [...draft.model];
		const [entry] = next.splice(index, 1);
		next.splice(index + delta, 0, entry);
		set("model", next);
	};
	const addModel = (value: string) => {
		const entry = value.trim();
		if (entry && !draft.model.includes(entry)) set("model", [...draft.model, entry]);
	};

	const fail = (message: string, cause?: unknown) => {
		setSaveError({ message, cause });
		requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: "nearest" }));
	};

	const save = async () => {
		setSubmitted(true);
		if (Object.keys(errors).length > 0) {
			fail(t("agentStudio.save.fixErrors"));
			return;
		}
		onSavingChange(true);
		setSaveError(null);
		try {
			const name = draft.name.trim();
			// A custom prewalk/advisor left empty means "off".
			const content = serializeAgentMarkdown(
				{
					...draft,
					prewalk: typeof draft.prewalk === "string" ? draft.prewalk.trim() : draft.prewalk,
					advisor: typeof draft.advisor === "string" ? draft.advisor.trim() : draft.advisor,
				},
				target.original,
			);
			const response = await rpc.writeAgentFile({ scope, name, content, replacePath: selfPath });
			if (!response.success) {
				if (response.code === "exists") fail(t("agentStudio.save.exists", { path: targetPath }));
				else fail(errorMessage(response), response);
				return;
			}
			const saved = response.data;
			const filePath =
				saved && typeof saved === "object" && "filePath" in saved && typeof saved.filePath === "string"
					? saved.filePath
					: targetPath;
			onSaved({ name, filePath });
		} catch (cause) {
			fail(errorMessage(cause), cause);
		} finally {
			onSavingChange(false);
		}
	};

	const nameError = visibleErrors.name ? t(`agentStudio.name.error.${visibleErrors.name}`) : undefined;
	const toolsMode = draft.tools === null ? "all" : "custom";

	return (
		<form
			className="flex flex-col gap-6"
			id={formId}
			noValidate
			onSubmit={event => {
				event.preventDefault();
				void save();
			}}
		>
			{saveError && (
				<div ref={errorRef}>
					<Banner live title={t("agentStudio.save.failed")} variant="danger">
						{saveError.message}
						<ErrorDetail className="mt-0.5" error={saveError.cause} />
					</Banner>
				</div>
			)}
			{target.mode === "edit" && target.parseError && (
				<Banner title={t("agentStudio.editor.parseErrorTitle")} variant="warning">
					{target.parseError}
				</Banner>
			)}

			<Section title={t("agentStudio.section.basics")}>
				<div className="flex flex-col gap-1.5">
					<span className="text-sc-sm font-medium text-(--sc-text-secondary)">{t("agentStudio.scope.label")}</span>
					<Tabs
						activeId={scope}
						ariaLabel={t("agentStudio.scope.label")}
						onChange={id => setScope(id as AgentFileScope)}
						tabs={[
							{ id: "user", label: t("agentStudio.scope.user") },
							{ id: "project", label: t("agentStudio.scope.project") },
						]}
						variant="segmented"
					/>
					<p className="text-sc-sm text-(--sc-text-muted)">{t(`agentStudio.scope.${scope}Hint`)}</p>
					<div className="flex min-w-0 items-center gap-2">
						<code
							className="min-w-0 flex-1 truncate font-mono text-sc-xs text-(--sc-text-secondary)"
							title={targetPath}
						>
							{targetPath}
						</code>
						{target.mode === "edit" && (
							<>
								<IconButton
									icon={<ExternalLink />}
									label={t("agentStudio.file.open")}
									onClick={() =>
										void revealAgentFile(target.filePath, "open", t("agentStudio.file.openFailed"))
									}
									size="sm"
								/>
								<IconButton
									icon={<FolderOpen />}
									label={t("agentStudio.file.reveal")}
									onClick={() =>
										void revealAgentFile(target.filePath, "reveal", t("agentStudio.file.openFailed"))
									}
									size="sm"
								/>
							</>
						)}
					</div>
				</div>
				<Input
					autoFocus={target.mode === "create"}
					error={nameError}
					hint={nameCheck.notice ? noticeText(nameCheck.notice) : t("agentStudio.name.hint")}
					label={t("agentStudio.name.label")}
					mono
					onChange={event => set("name", event.target.value)}
					placeholder={t("agentStudio.editor.namePlaceholder")}
					spellCheck={false}
					value={draft.name}
				/>
				<TextArea
					autoGrow
					error={visibleErrors.description ? t("agentStudio.description.required") : undefined}
					hint={t("agentStudio.description.hint")}
					label={t("agentStudio.description.label")}
					onChange={event => set("description", event.target.value)}
					rows={2}
					value={draft.description}
				/>
			</Section>

			<Section title={t("agentStudio.section.instructions")}>
				<div className="flex flex-col gap-1.5">
					<MarkdownEditor
						ariaLabel={t("agentStudio.instructions.label")}
						className="h-80"
						describedBy={instructionsHintId}
						invalid={Boolean(visibleErrors.instructions)}
						onChange={value => set("instructions", value)}
						value={draft.instructions}
					/>
					<p
						className={cx(
							"text-sc-sm",
							visibleErrors.instructions ? "text-(--sc-danger)" : "text-(--sc-text-muted)",
						)}
						id={instructionsHintId}
					>
						{visibleErrors.instructions
							? t("agentStudio.instructions.required")
							: t("agentStudio.instructions.hint")}
					</p>
				</div>
			</Section>

			<Section title={t("agentStudio.section.capabilities")}>
				<Select
					hint={toolsMode === "all" ? t("agentStudio.tools.allHint") : t("agentStudio.tools.customHint")}
					label={t("agentStudio.tools.label")}
					onChange={event =>
						set("tools", event.target.value === "all" ? null : [...(draft.tools ?? READ_ONLY_TOOLS)])
					}
					options={[
						{ value: "all", label: t("agentStudio.tools.all") },
						{ value: "custom", label: t("agentStudio.tools.custom") },
					]}
					value={toolsMode}
				/>
				{draft.tools !== null && (
					<ChipGroup
						actions={
							<div className="flex gap-1">
								<Button onClick={() => set("tools", [...READ_ONLY_TOOLS])} size="sm" variant="ghost">
									{t("agentStudio.tools.readOnlyPreset")}
								</Button>
								<Button onClick={() => set("tools", [])} size="sm" variant="ghost">
									{t("agentStudio.tools.clear")}
								</Button>
							</div>
						}
						label={t("agentStudio.tools.selected", { count: draft.tools.length })}
						onToggle={tool => set("tools", toggleIn(draft.tools ?? [], tool))}
						options={data.tools}
						selected={draft.tools}
					/>
				)}
				<Select
					hint={t(`agentStudio.spawns.${spawnsMode}Hint`)}
					label={t("agentStudio.spawns.label")}
					onChange={event => {
						const next = event.target.value as SpawnsMode;
						setSpawnsMode(next);
						set("spawns", next === "all" ? "*" : next === "custom" && draft.spawns !== "*" ? draft.spawns : []);
					}}
					options={[
						{ value: "none", label: t("agentStudio.spawns.none") },
						{ value: "all", label: t("agentStudio.spawns.all") },
						{ value: "custom", label: t("agentStudio.spawns.custom") },
					]}
					value={spawnsMode}
				/>
				{spawnsMode === "custom" && draft.spawns !== "*" && (
					<ChipGroup
						label={t("agentStudio.spawns.pick")}
						onToggle={name => set("spawns", toggleIn(draft.spawns === "*" ? [] : draft.spawns, name))}
						options={agentNames}
						selected={draft.spawns}
					/>
				)}
				<ChipGroup
					hint={data.skills.length === 0 ? t("agentStudio.skills.none") : t("agentStudio.skills.hint")}
					label={t("agentStudio.skills.label")}
					onToggle={skill => set("autoloadSkills", toggleIn(draft.autoloadSkills, skill))}
					options={data.skills}
					selected={draft.autoloadSkills}
				/>
			</Section>

			<Section title={t("agentStudio.section.model")}>
				<div className="flex flex-col gap-1.5">
					<span className="text-sc-sm font-medium text-(--sc-text-secondary)">{t("agentStudio.model.label")}</span>
					{draft.model.length === 0 ? (
						<p className="text-sc-sm text-(--sc-text-muted)">{t("agentStudio.model.empty")}</p>
					) : (
						<ol className="flex flex-col divide-y divide-(--sc-divider) rounded-(--sc-radius-md) border border-(--sc-border-subtle)">
							{draft.model.map((entry, index) => {
								const role = roleByValue.get(entry);
								return (
									<li className="flex items-center gap-2 py-1 pr-1 pl-3" key={entry}>
										<span className="w-5 shrink-0 text-sc-xs text-(--sc-text-subtle)">{index + 1}</span>
										<span className="min-w-0 flex-1">
											<span className="block truncate font-mono text-sc-sm text-(--sc-text)">{entry}</span>
											{role && (
												<span className="block truncate text-sc-xs text-(--sc-text-muted)">
													{role.model
														? t("agentStudio.model.roleResolved", { role: role.name, model: role.model })
														: t("agentStudio.model.roleUnset", { role: role.name })}
												</span>
											)}
										</span>
										<IconButton
											disabled={index === 0}
											icon={<ArrowUp />}
											label={t("agentStudio.model.moveUp", { entry })}
											onClick={() => moveModel(index, -1)}
											size="sm"
										/>
										<IconButton
											disabled={index === draft.model.length - 1}
											icon={<ArrowDown />}
											label={t("agentStudio.model.moveDown", { entry })}
											onClick={() => moveModel(index, 1)}
											size="sm"
										/>
										<IconButton
											icon={<X />}
											label={t("agentStudio.model.remove", { entry })}
											onClick={() =>
												set(
													"model",
													draft.model.filter(item => item !== entry),
												)
											}
											size="sm"
										/>
									</li>
								);
							})}
						</ol>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<MenuButton
							items={data.roles.map(role => ({
								id: role.value,
								label: role.name,
								hint: role.value,
								description: role.model,
								disabled: draft.model.includes(role.value),
								onSelect: () => addModel(role.value),
							}))}
							label={t("agentStudio.model.addRole")}
							size="sm"
							variant="secondary"
						>
							{t("agentStudio.model.addRole")}
						</MenuButton>
						<ModelValueSelect
							ariaLabel={t("agentStudio.model.addModel")}
							kind="model"
							onCommit={addModel}
							placeholder={t("agentStudio.model.addModel")}
							value=""
						/>
					</div>
					<p className="text-sc-sm text-(--sc-text-muted)">{t("agentStudio.model.hint")}</p>
				</div>
				<Select
					hint={t("agentStudio.thinking.hint")}
					label={t("agentStudio.thinking.label")}
					onChange={event => set("thinkingLevel", event.target.value)}
					options={[
						{ value: "", label: t("agentStudio.thinking.inherit") },
						...AGENT_THINKING_LEVELS.map(level => ({ value: level, label: t(`input.thinking.name.${level}`) })),
					]}
					value={draft.thinkingLevel}
				/>
				<PatternField
					description={t("agentStudio.prewalk.hint")}
					label={t("agentStudio.prewalk.label")}
					onChange={value => set("prewalk", value)}
					placeholder="@smol"
					value={draft.prewalk}
				/>
				<PatternField
					description={t("agentStudio.advisor.hint")}
					label={t("agentStudio.advisor.label")}
					onChange={value => set("advisor", value)}
					placeholder="@advisor"
					value={draft.advisor}
				/>
			</Section>

			<Section title={t("agentStudio.section.behavior")}>
				<SwitchField
					checked={draft.blocking}
					description={t("agentStudio.blocking.hint")}
					label={t("agentStudio.blocking.label")}
					onCheckedChange={value => set("blocking", value)}
				/>
				<SwitchField
					checked={draft.readSummarize}
					description={t("agentStudio.readSummarize.hint")}
					label={t("agentStudio.readSummarize.label")}
					onCheckedChange={value => set("readSummarize", value)}
				/>
				<TextArea
					autoGrow
					error={
						visibleErrors.output
							? visibleErrors.output === "not-object"
								? t("agentStudio.output.notObject")
								: t("agentStudio.output.invalid", { error: visibleErrors.output })
							: undefined
					}
					hint={t("agentStudio.output.hint")}
					label={t("agentStudio.output.label")}
					mono
					onChange={event => set("output", event.target.value)}
					placeholder='{ "properties": { "summary": { "type": "string" } } }'
					rows={3}
					spellCheck={false}
					value={draft.output}
				/>
			</Section>
		</form>
	);
}
