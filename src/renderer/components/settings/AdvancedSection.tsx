/**
 * Settings › Advanced: everything not curated elsewhere. Category "launch"
 * holds the app's network proxy and the per-project omp launch profile; each
 * agent schema tab follows with every GUI-relevant setting (source layers
 * shown for configured values); "other" lists settings without UI metadata.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flagsToCommandLine, type LaunchProfile, profileToFlags } from "../../../shared/launch-profile";
import type { SettingEntry } from "../../../shared/rpc-types";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useLang, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { useFocusedHost, useFocusedTabDevice } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { focusedSessionRuntime, sessionRuntime, withSessionRuntime } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { CodeBlock } from "../chat/CodeBlock";
import { Banner, Button, EmptyState, Input, Select, TextArea } from "../common";
import { HostScoped, ThisDeviceTag } from "../remote/HostScope";
import { ArrayChipEditor } from "./editors/ArrayChipEditor";
import { SchemaSettingRow } from "./SchemaSettingRow";
import { SettingsRow, SettingsSection, SettingsSwitchRow } from "./SettingsLayout";
import { schemaGroupTitle } from "./schema-i18n";
import {
	ADVANCED_LAUNCH_CATEGORY,
	ADVANCED_OTHER_CATEGORY,
	LAUNCH_TEXT_FIELDS,
	LAUNCH_VERBATIM_FIELDS,
	type LaunchTextField,
} from "./settings-catalog";
import { useSettingsData } from "./settings-data";
import { groupSchemaEntries, isSettingSupportedInGui, isSettingVisibleInGui } from "./settings-schema-utils";

/**
 * HTTP proxy for omp's network traffic — this device's own sessions (a paired
 * host's tabs use the host's); saving restarts an idle local sidecar so it applies.
 */
function ProxyRow() {
	const t = useT();
	const host = useFocusedHost();
	const [draft, setDraft] = useState<string | null>(null);
	const [saved, setSaved] = useState("");
	const [saving, setSaving] = useState(false);
	const pending = useRef(false);
	const inputId = useId();

	useEffect(() => {
		let cancelled = false;
		void window.omp.prefs
			.get("proxyUrl")
			.then(value => {
				if (!cancelled) setSaved(typeof value === "string" ? value : "");
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const commit = async () => {
		if (draft === null || pending.current) return;
		const next = draft.trim();
		if (next === saved) {
			setDraft(null);
			return;
		}
		const origin = focusedSessionRuntime();
		const remote = host !== undefined;
		pending.current = true;
		setSaving(true);
		try {
			const ok = await saveGuiPreference("proxyUrl", next || null, () => {
				setSaved(next);
				setDraft(current => (current === draft ? null : current));
			});
			if (!ok) return;
			if (remote) {
				toast({ variant: "info", message: t("settings.gui.proxySavedThisDevice") });
				return;
			}
			const restart = () => {
				const state = useSessionStore.getState();
				if (state.status !== "ready" || state.isStreaming || state.isCompacting) return null;
				return window.omp.sidecar.restart({ tabId: origin?.tabId, sessionPath: state.sessionFile ?? undefined });
			};
			const restarted = origin
				? sessionRuntime(origin.tabId) === origin
					? withSessionRuntime(origin.tabId, restart)
					: null
				: restart();
			if (restarted) await restarted;
			toast({
				variant: "info",
				message: t(restarted ? "settings.gui.proxyApplied" : "settings.gui.proxySavedPending"),
			});
		} catch (error) {
			toastError({ title: t("pluginActivation.restartFailed"), error });
		} finally {
			pending.current = false;
			setSaving(false);
		}
	};

	return (
		<SettingsRow
			badge={<ThisDeviceTag />}
			control={
				<Input
					disabled={saving}
					id={inputId}
					mono
					onBlur={() => void commit()}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={event => {
						if (isImeKeyEvent(event)) return;
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					placeholder="http://127.0.0.1:7890"
					spellCheck={false}
					value={draft ?? saved}
				/>
			}
			description={t("settings.gui.proxyDesc")}
			htmlFor={inputId}
			id="setting-gui-proxy"
			label={t("settings.gui.proxy")}
		/>
	);
}

/**
 * Per-project omp launch flags, applied on the next sidecar start. Profiles
 * live on the machine that spawns omp: a remote tab reads and writes its
 * host's (`device`), and its extra folders come from the host's disk.
 */
function LaunchProfileSection() {
	const t = useT();
	const cwd = useSessionStore(state => state.cwd);
	const device = useFocusedTabDevice();
	const { sidecarBusy } = useSettingsData();
	const [profile, setProfile] = useState<LaunchProfile>({});
	const [drafts, setDrafts] = useState<Partial<Record<LaunchTextField, string>>>({});
	const [saving, setSaving] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const pending = useRef<Promise<boolean> | null>(null);
	const version = useRef(0);
	const ids = {
		systemPrompt: useId(),
		appendSystemPrompt: useId(),
		profile: useId(),
		sessionDir: useId(),
		config: useId(),
	} satisfies Record<LaunchTextField, string>;

	// In-progress drafts are project-local: a project switch resets them.
	useEffect(() => {
		let cancelled = false;
		const current = ++version.current;
		setDrafts({});
		void window.omp.prefs
			.getLaunchProfile(cwd, device)
			.then(next => {
				if (cancelled || current !== version.current) return;
				setProfile(next);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [cwd, device]);

	// Patch only edited fields; main owns the atomic per-project merge.
	const update = useCallback(
		async (patch: Partial<LaunchProfile>): Promise<boolean> => {
			const current = ++version.current;
			const previous = pending.current;
			setSaving(true);
			const write = (async () => {
				await previous;
				try {
					const next = await window.omp.prefs.updateLaunchProfile(cwd, patch, device);
					if (current !== version.current) return false;
					setProfile(next);
					return true;
				} catch (error) {
					toastError({ title: t("settings.saveFailed"), error });
					return false;
				}
			})();
			pending.current = write;
			try {
				return await write;
			} finally {
				if (pending.current === write) {
					pending.current = null;
					setSaving(false);
				}
			}
		},
		[cwd, device, t],
	);

	const commitField = async (field: LaunchTextField) => {
		const draft = drafts[field];
		if (draft === undefined) return;
		const value = LAUNCH_VERBATIM_FIELDS[field] === true ? draft : draft.trim();
		if (!(await update({ [field]: value === "" ? undefined : value }))) return;
		setDrafts(previous => {
			if (previous[field] !== draft) return previous;
			const next = { ...previous };
			delete next[field];
			return next;
		});
	};

	const pickAddDirs = async () => {
		const current = version.current;
		// The native panel can multi-select this device's folders; a host's come one at a time from its picker.
		const picked =
			device === undefined
				? await window.omp.system.showOpenDialog([], { directory: true }).catch(() => null)
				: await pickWorkspaceDirectory({ device }).then(path => (path ? [path] : null));
		if (!picked || picked.length === 0 || current !== version.current) return;
		const existing = profile.addDirs ?? [];
		const merged = [...existing];
		for (const dir of picked) if (!merged.includes(dir)) merged.push(dir);
		if (merged.length !== existing.length) await update({ addDirs: merged });
	};

	const restart = () => {
		if (sidecarBusy || restarting || pending.current || Object.keys(drafts).length) return;
		setRestarting(true);
		// The respawned sidecar resumes the active session (--session) instead of starting fresh.
		const { sessionFile } = useSessionStore.getState();
		const origin = focusedSessionRuntime();
		void window.omp.sidecar
			.restart({ tabId: origin?.tabId, sessionPath: sessionFile ?? undefined })
			.then(() => toast({ variant: "info", message: t("settings.launch.restarting") }))
			.catch(error => toastError({ title: t("pluginActivation.restartFailed"), error }))
			.finally(() => setRestarting(false));
	};

	// Exactly what runs on the next sidecar start: drafts win over saved values.
	const preview = useMemo(() => {
		const effective: LaunchProfile = { ...profile };
		for (const field of LAUNCH_TEXT_FIELDS) {
			const draft = drafts[field];
			if (draft === undefined) continue;
			const value = LAUNCH_VERBATIM_FIELDS[field] === true ? draft : draft.trim();
			if (value === "") delete effective[field];
			else effective[field] = value;
		}
		const suffix = flagsToCommandLine(profileToFlags(effective));
		return suffix === "" ? "omp --mode rpc-ui" : `omp --mode rpc-ui ${suffix}`;
	}, [profile, drafts]);

	const locked = saving || restarting;
	const textField = (field: LaunchTextField, multiline: boolean) => {
		const common = {
			disabled: locked,
			id: ids[field],
			onBlur: () => void commitField(field),
			placeholder: t(`settings.launch.${field}Placeholder`),
			spellCheck: false,
			value: drafts[field] ?? profile[field] ?? "",
		};
		return multiline ? (
			<TextArea
				{...common}
				mono
				onChange={event => setDrafts(previous => ({ ...previous, [field]: event.target.value }))}
				rows={3}
			/>
		) : (
			<Input
				{...common}
				mono
				onChange={event => setDrafts(previous => ({ ...previous, [field]: event.target.value }))}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
		);
	};

	return (
		<SettingsSection
			description={t("settings.launch.description", { project: cwd })}
			id="setting-gui-launch"
			title={t("settings.launch.title")}
		>
			<SettingsRow htmlFor={ids.systemPrompt} label={t("settings.launch.systemPrompt")}>
				{textField("systemPrompt", true)}
			</SettingsRow>
			<SettingsRow htmlFor={ids.appendSystemPrompt} label={t("settings.launch.appendSystemPrompt")}>
				{textField("appendSystemPrompt", true)}
			</SettingsRow>
			<SettingsRow description={t("settings.launch.addDirsDesc")} label={t("settings.launch.addDirs")}>
				<ArrayChipEditor
					disabled={locked}
					onCommit={dirs => update({ addDirs: dirs })}
					placeholder={t("settings.launch.addDirsPlaceholder")}
					values={profile.addDirs ?? []}
				/>
				<div className="mt-2">
					<Button disabled={locked} onClick={() => void pickAddDirs()} size="sm" variant="secondary">
						{t("settings.launch.addDirPick")}
					</Button>
				</div>
			</SettingsRow>
			<SettingsRow description={t("settings.launch.toolsDesc")} label={t("settings.launch.tools")}>
				<ArrayChipEditor disabled={locked} onCommit={tools => update({ tools })} values={profile.tools ?? []} />
			</SettingsRow>
			<SettingsSwitchRow
				checked={profile.noRules === true}
				description={t("settings.launch.noRulesDesc")}
				disabled={locked}
				label={t("settings.launch.noRules")}
				onCheckedChange={value => void update({ noRules: value })}
			/>
			<SettingsSwitchRow
				checked={profile.noLsp === true}
				description={t("settings.launch.noLspDesc")}
				disabled={locked}
				label={t("settings.launch.noLsp")}
				onCheckedChange={value => void update({ noLsp: value })}
			/>
			<SettingsSwitchRow
				checked={profile.planYolo === true}
				description={t("settings.launch.planYoloDesc")}
				disabled={locked}
				label={t("settings.launch.planYolo")}
				onCheckedChange={value => void update({ planYolo: value })}
			/>
			<SettingsRow
				control={textField("profile", false)}
				htmlFor={ids.profile}
				label={t("settings.launch.profile")}
			/>
			<SettingsRow
				control={textField("sessionDir", false)}
				htmlFor={ids.sessionDir}
				label={t("settings.launch.sessionDir")}
			/>
			<SettingsRow control={textField("config", false)} htmlFor={ids.config} label={t("settings.launch.config")} />
			<SettingsRow label={t("settings.launch.preview")}>
				<CodeBlock code={preview} language="bash" showCopy={false} showLineNumbers={false} />
			</SettingsRow>
			<Banner
				actions={
					<Button
						disabled={sidecarBusy || restarting || saving || Object.keys(drafts).length > 0}
						loading={restarting}
						onClick={restart}
						size="sm"
						variant="secondary"
					>
						{t("settings.launch.restartNow")}
					</Button>
				}
				className="mt-3"
				variant="warning"
			>
				{t(sidecarBusy ? "settings.launch.busyHint" : "settings.launch.restartNote")}
			</Banner>
		</SettingsSection>
	);
}

function SchemaRows({ entries }: { entries: SettingEntry[] }) {
	const { values, onCommitted } = useSettingsData();
	return (
		<>
			{entries.map(entry => (
				<SchemaSettingRow
					entry={entry}
					key={entry.path}
					onCommitted={onCommitted}
					showSource
					value={values[entry.path]}
				/>
			))}
		</>
	);
}

/** Every GUI-relevant setting of one agent schema tab, grouped as the schema declares. */
export function SchemaTabSettings({ tabId, groups }: { tabId: string; groups: string[] }) {
	const t = useT();
	const { lang } = useLang();
	const { schema, values } = useSettingsData();
	const visible = useMemo(
		() => (schema?.entries ?? []).filter(entry => isSettingVisibleInGui(entry, values)),
		[schema, values],
	);
	const { tabEntries, ungrouped, orderedGroups } = useMemo(
		() => groupSchemaEntries(visible, tabId, groups),
		[visible, tabId, groups],
	);
	if (tabEntries.length === 0) return <EmptyState size="sm" title={t("settings.sectionEmpty")} />;
	return (
		<>
			{ungrouped.length > 0 && (
				<div className="settings-section-body">
					<SchemaRows entries={ungrouped} />
				</div>
			)}
			{orderedGroups.map(group => (
				<SettingsSection key={group.name} title={schemaGroupTitle(lang, group.name)}>
					<SchemaRows entries={group.entries} />
				</SettingsSection>
			))}
		</>
	);
}

export function AdvancedSection({
	category: requested,
	onCategoryChange,
}: {
	category: string | undefined;
	onCategoryChange: (category: string) => void;
}) {
	const t = useT();
	const { schema, values, loadState, sidecarReady } = useSettingsData();
	const selectId = useId();
	const tabs = useMemo(
		() =>
			(schema?.tabs ?? []).filter(tab =>
				schema?.entries.some(entry => entry.tab === tab.id && isSettingSupportedInGui(entry)),
			),
		[schema],
	);
	const other = useMemo(
		() =>
			(schema?.entries ?? []).filter(
				entry => (entry.advanced === true || entry.tab === undefined) && isSettingVisibleInGui(entry, values),
			),
		[schema, values],
	);
	const tabLabel = (id: string, fallback: string) => {
		const key = `settings.tabs.${id}`;
		const translated = t(key);
		return translated === key ? fallback : translated;
	};
	const category = requested ?? ADVANCED_LAUNCH_CATEGORY;
	const schemaReady = sidecarReady && loadState === "ready" && schema !== null;
	const activeTab = tabs.find(tab => tab.id === category);

	return (
		<>
			<SettingsRow
				control={
					<Select id={selectId} onChange={event => onCategoryChange(event.target.value)} value={category}>
						<option value={ADVANCED_LAUNCH_CATEGORY}>{t("settings.advanced.launch")}</option>
						{tabs.map(tab => (
							<option key={tab.id} value={tab.id}>
								{tabLabel(tab.id, tab.label)}
							</option>
						))}
						{!activeTab && category !== ADVANCED_LAUNCH_CATEGORY && category !== ADVANCED_OTHER_CATEGORY && (
							<option value={category}>{tabLabel(category, category)}</option>
						)}
						<option value={ADVANCED_OTHER_CATEGORY}>{t("settings.advanced.other")}</option>
					</Select>
				}
				description={t("settings.advanced.categoryDesc")}
				htmlFor={selectId}
				id="settings-advanced-category"
				label={t("settings.advanced.category")}
			/>
			<div className="mt-6">
				{category === ADVANCED_LAUNCH_CATEGORY ? (
					<>
						<SettingsSection title={t("settings.advanced.network")}>
							<ProxyRow />
						</SettingsSection>
						<HostScoped>
							<LaunchProfileSection />
						</HostScoped>
					</>
				) : (
					<HostScoped>
						{!schemaReady ? (
							loadState === "loading" && <div aria-hidden className="omp-skeleton h-40 w-full" />
						) : category === ADVANCED_OTHER_CATEGORY ? (
							other.length === 0 ? (
								<EmptyState size="sm" title={t("settings.advancedEmpty")} />
							) : (
								<div className="settings-section-body">
									<SchemaRows entries={other} />
								</div>
							)
						) : (
							<SchemaTabSettings groups={activeTab?.groups ?? []} tabId={category} />
						)}
					</HostScoped>
				)}
			</div>
		</>
	);
}
