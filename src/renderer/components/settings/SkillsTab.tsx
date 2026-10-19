/**
 * Skills tab of Settings › Extensions: every skill available to the active
 * session in a master list (enable switch per row) beside the selected
 * skill's detail (metadata + instruction preview). OMP-managed skills can be
 * created, edited and deleted here; authored and plugin skills are
 * read-only. Filtering is the page search (`query`) plus a status/source
 * Select.
 */

import { BookOpen, FileText, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcSkillDetail, RpcSkillInfo, RpcSkillsResult } from "../../../shared/rpc-types";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import {
	Badge,
	Banner,
	Button,
	ConfirmDialog,
	EmptyState,
	ErrorDetail,
	IconButton,
	Input,
	ListRow,
	Select,
	SkeletonRows,
	Switch,
	TextArea,
} from "../common";

type SkillFilter = "all" | "enabled" | "disabled" | "managed" | "project" | "user";
type EditorState = {
	mode: "create" | "update";
	name: string;
	description: string;
	body: string;
};

const FILTER_OPTIONS: SkillFilter[] = ["all", "enabled", "disabled", "managed", "project", "user"];

export function filterSkills(skills: RpcSkillInfo[], query: string, filter: SkillFilter): RpcSkillInfo[] {
	const needle = query.trim().toLocaleLowerCase();
	return skills.filter(skill => {
		if (filter === "enabled" && !skill.enabled) return false;
		if (filter === "disabled" && skill.enabled) return false;
		if (filter === "managed" && !skill.managed) return false;
		if (filter === "project" && skill.level !== "project") return false;
		if (filter === "user" && skill.level !== "user") return false;
		if (!needle) return true;
		return [skill.name, skill.description, skill.provider, skill.providerName, skill.source]
			.join(" ")
			.toLocaleLowerCase()
			.includes(needle);
	});
}

export function SkillsTab({ query }: { query: string }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status === "ready");
	const cwd = useSessionStore(state => state.cwd);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const routeReady = useActiveTabRouteReady();
	const routeKey = `${activeTabId ?? "none"}:${cwd}`;
	const routeRef = useRef(routeKey);
	const [skills, setSkills] = useState<RpcSkillInfo[]>([]);
	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [detail, setDetail] = useState<RpcSkillDetail | null>(null);
	const [filter, setFilter] = useState<SkillFilter>("all");
	const [loading, setLoading] = useState(true);
	const [detailLoading, setDetailLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [detailAttempt, setDetailAttempt] = useState(0);
	const [busyName, setBusyName] = useState<string | null>(null);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [deleteArmed, setDeleteArmed] = useState(false);
	const listRequest = useRef(0);
	const detailRequest = useRef(0);
	const notConnected = !sidecarReady ? t("common.notConnected") : undefined;

	const loadSkills = useCallback(
		async (preferredName?: string | null) => {
			if (!sidecarReady) {
				setError(t("common.notConnected"));
				setLoading(false);
				return;
			}
			if (!routeReady) return;
			const request = ++listRequest.current;
			setLoading(true);
			setError(null);
			try {
				const response = await tabRpc.getSkills();
				if (request !== listRequest.current) return;
				if (!response.success) throw new Error(response.error);
				const next = ((response.data as RpcSkillsResult | undefined)?.skills ?? []).sort((a, b) =>
					a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
				);
				setSkills(next);
				setSelectedName(current => {
					const wanted = preferredName ?? current;
					return wanted && next.some(skill => skill.name === wanted) ? wanted : (next[0]?.name ?? null);
				});
			} catch (cause) {
				if (request === listRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (request === listRequest.current) setLoading(false);
			}
		},
		[routeReady, sidecarReady, t, tabRpc.getSkills],
	);

	useEffect(() => {
		routeRef.current = routeKey;
		listRequest.current += 1;
		detailRequest.current += 1;
		setSkills([]);
		setSelectedName(null);
		setDetail(null);
		setEditor(null);
		setDeleteArmed(false);
		setBusyName(null);
		if (sidecarReady && routeReady) void loadSkills();
	}, [loadSkills, routeKey, routeReady, sidecarReady]);

	/* `detailAttempt` is never read inside: it is the retry button's bump that re-runs
	   this same detail read, which has no loader of its own to call. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry is a dependency by bump
	useEffect(() => {
		setDeleteArmed(false);
		setDetail(null);
		setDetailError(null);
		if (!selectedName || !routeReady) return;
		if (!sidecarReady) {
			setDetailError(t("common.notConnected"));
			return;
		}
		// `startCreate` clears the selection before opening the editor. Clearing
		// the editor before this guard immediately erased that freshly opened
		// form, making the New skill action appear inert.
		setEditor(null);
		const request = ++detailRequest.current;
		const requestRoute = routeKey;
		setDetailLoading(true);
		void tabRpc
			.getSkillDetail(selectedName)
			.then(response => {
				if (request !== detailRequest.current || requestRoute !== routeRef.current) return;
				if (!response.success) throw new Error(response.error);
				setDetail(response.data as RpcSkillDetail);
			})
			.catch(cause => {
				if (request === detailRequest.current && requestRoute === routeRef.current) {
					setDetailError(cause instanceof Error ? cause.message : String(cause));
				}
			})
			.finally(() => {
				if (request === detailRequest.current && requestRoute === routeRef.current) setDetailLoading(false);
			});
	}, [detailAttempt, routeKey, routeReady, selectedName, sidecarReady, t, tabRpc.getSkillDetail]);

	const visible = useMemo(() => filterSkills(skills, query, filter), [filter, query, skills]);
	const selected = skills.find(skill => skill.name === selectedName) ?? null;

	const toggle = async (skill: RpcSkillInfo) => {
		if (!sidecarReady || busyName) return;
		const mutationRoute = routeKey;
		const enabled = !skill.enabled;
		setBusyName(skill.name);
		setSkills(current => current.map(item => (item.name === skill.name ? { ...item, enabled } : item)));
		try {
			const response = await tabRpc.setSkillEnabled(skill.name, enabled);
			if (!response.success) throw new Error(response.error);
			if (mutationRoute !== routeRef.current) return;
			await loadSkills(skill.name);
		} catch (cause) {
			if (mutationRoute !== routeRef.current) return;
			setSkills(current =>
				current.map(item => (item.name === skill.name ? { ...item, enabled: skill.enabled } : item)),
			);
			toastError({ title: t("settings.skills.toggleFailed"), error: cause });
		} finally {
			setBusyName(null);
		}
	};

	const save = async () => {
		if (!sidecarReady || !editor || busyName) return;
		const mutationRoute = routeKey;
		setBusyName(editor.name || "new");
		try {
			const response = await tabRpc.manageSkill({
				action: editor.mode,
				name: editor.name,
				description: editor.description,
				body: editor.body,
			});
			if (!response.success) throw new Error(response.error);
			if (mutationRoute !== routeRef.current) return;
			setEditor(null);
			await loadSkills(editor.name.trim().toLocaleLowerCase());
			toast({ variant: "success", message: t(`settings.skills.${editor.mode}Success`) });
		} catch (cause) {
			if (mutationRoute !== routeRef.current) return;
			toastError({ title: t("settings.skills.saveFailed"), error: cause });
		} finally {
			setBusyName(null);
		}
	};

	const remove = async () => {
		if (!sidecarReady || !selected?.managed || busyName) return;
		const mutationRoute = routeKey;
		setBusyName(selected.name);
		try {
			const response = await tabRpc.manageSkill({ action: "delete", name: selected.name });
			if (!response.success) throw new Error(response.error);
			if (mutationRoute !== routeRef.current) return;
			setDeleteArmed(false);
			setDetail(null);
			await loadSkills(null);
			toast({ variant: "success", message: t("settings.skills.deleteSuccess") });
		} catch (cause) {
			if (mutationRoute !== routeRef.current) return;
			toastError({ title: t("settings.skills.deleteFailed"), error: cause });
		} finally {
			setBusyName(null);
		}
	};

	const startCreate = () => {
		setSelectedName(null);
		setDeleteArmed(false);
		setEditor({ mode: "create", name: "", description: "", body: "# Instructions\n\n" });
	};

	const startEdit = () => {
		if (!detail?.managed) return;
		setDeleteArmed(false);
		setEditor({ mode: "update", name: detail.name, description: detail.description, body: detail.body });
	};

	let listBody: ReactNode;
	if (error) {
		// A failed read outranks the empty list: an outage must not read as "no skills installed".
		listBody = (
			<div className="p-3">
				<Banner
					actions={
						<Button disabled={!sidecarReady} onClick={() => void loadSkills()} size="sm" title={notConnected}>
							{t("common.retry")}
						</Button>
					}
					title={t("settings.skills.loadFailed")}
					variant="danger"
				>
					<ErrorDetail error={error} />
				</Banner>
			</div>
		);
	} else if (loading && skills.length === 0) {
		listBody = <SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />;
	} else if (visible.length === 0) {
		listBody = (
			<EmptyState
				actions={
					filter !== "all" ? (
						<Button onClick={() => setFilter("all")} size="sm" variant="ghost">
							{t("settings.skills.showAll")}
						</Button>
					) : skills.length === 0 ? (
						<Button disabled={!sidecarReady || !routeReady} onClick={startCreate} size="sm">
							{t("settings.skills.new")}
						</Button>
					) : undefined
				}
				icon={<BookOpen />}
				size="sm"
				title={t("settings.skills.empty")}
			/>
		);
	} else {
		listBody = (
			<div className="flex h-full flex-col gap-px overflow-y-auto p-1.5">
				{visible.map(skill => {
					const active = skill.name === selectedName && editor?.mode !== "create";
					return (
						<ListRow
							description={`${skill.providerName} · ${t(`settings.skills.scope.${skill.level}`)}`}
							key={`${skill.provider}:${skill.name}`}
							leading={<FileText />}
							meta={
								<span className="relative z-(--sc-z-raised) flex items-center">
									<Switch
										checked={skill.enabled}
										disabled={!sidecarReady || busyName !== null}
										label={`${skill.name}: ${skill.enabled ? t("settings.skills.enabled") : t("settings.skills.disabled")}`}
										onCheckedChange={() => void toggle(skill)}
										size="sm"
									/>
								</span>
							}
							onClick={() => setSelectedName(skill.name)}
							selected={active}
							title={<span className="font-mono">{skill.name}</span>}
							titleText={skill.name}
						/>
					);
				})}
			</div>
		);
	}

	let detailBody: ReactNode;
	if (editor) {
		detailBody = (
			<div className="flex flex-col gap-4">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h3 className="text-sc-lg font-semibold text-(--sc-text)">
							{t(`settings.skills.editor.${editor.mode}`)}
						</h3>
						<p className="mt-0.5 text-sc-sm text-(--sc-text-muted)">{t("settings.skills.editor.hint")}</p>
					</div>
					<IconButton icon={<X />} label={t("common.cancel")} onClick={() => setEditor(null)} size="sm" />
				</div>
				<Input
					disabled={editor.mode === "update"}
					label={t("settings.skills.field.name")}
					mono
					onChange={event => setEditor(current => (current ? { ...current, name: event.target.value } : null))}
					placeholder="my-skill"
					spellCheck={false}
					value={editor.name}
				/>
				<Input
					label={t("settings.skills.field.description")}
					onChange={event =>
						setEditor(current => (current ? { ...current, description: event.target.value } : null))
					}
					placeholder={t("settings.skills.field.descriptionPlaceholder")}
					value={editor.description}
				/>
				<TextArea
					className="min-h-64"
					label={t("settings.skills.field.body")}
					mono
					onChange={event => setEditor(current => (current ? { ...current, body: event.target.value } : null))}
					rows={14}
					spellCheck={false}
					value={editor.body}
				/>
				<div className="flex justify-end gap-2">
					<Button onClick={() => setEditor(null)} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!sidecarReady || !editor.name.trim() || !editor.description.trim() || !editor.body.trim()}
						loading={busyName !== null}
						onClick={() => void save()}
						size="sm"
						title={notConnected}
						variant="primary"
					>
						{t("common.save")}
					</Button>
				</div>
			</div>
		);
	} else if (selected) {
		detailBody = (
			<div className="flex min-h-full flex-col gap-5">
				<header className="flex items-start gap-3 border-b border-(--sc-divider) pb-4">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<h3 className="font-mono text-sc-lg font-semibold text-(--sc-text)">{selected.name}</h3>
							{selected.managed && <Badge variant="accent">{t("settings.skills.managed")}</Badge>}
							<Badge variant="default">{t(`settings.skills.scope.${selected.level}`)}</Badge>
							{selected.hidden && <Badge variant="muted">{t("settings.skills.manualOnly")}</Badge>}
						</div>
						<p className="mt-1 max-w-5xl text-sc-sm text-(--sc-text-muted)">
							{selected.description || t("settings.skills.noDescription")}
						</p>
					</div>
					{selected.managed && (
						<div className="flex gap-0.5">
							<IconButton
								disabled={!sidecarReady || !detail}
								icon={<Pencil />}
								label={t("common.edit")}
								onClick={startEdit}
								size="sm"
							/>
							<IconButton
								disabled={!sidecarReady}
								icon={<Trash2 />}
								label={t("common.delete")}
								onClick={() => setDeleteArmed(true)}
								size="sm"
							/>
						</div>
					)}
				</header>

				<dl className="grid grid-cols-[90px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sc-sm">
					<dt className="text-(--sc-text-muted)">{t("settings.skills.provider")}</dt>
					<dd className="text-(--sc-text-secondary)">{selected.providerName}</dd>
					<dt className="text-(--sc-text-muted)">{t("settings.skills.location")}</dt>
					<dd className="truncate font-mono text-(--sc-text-secondary)" title={selected.location}>
						{shortenPath(selected.location)}
					</dd>
					<dt className="text-(--sc-text-muted)">{t("settings.skills.status")}</dt>
					<dd>
						<Badge dot variant={selected.enabled ? "success" : "muted"}>
							{selected.enabled ? t("settings.skills.enabled") : t("settings.skills.disabled")}
						</Badge>
					</dd>
				</dl>

				<div className="flex min-h-48 flex-1 flex-col">
					<h4 className="mb-2 text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase">
						{t("settings.skills.preview")}
					</h4>
					{detailLoading ? (
						<SkeletonRows className="py-2" label={t("common.loading")} widths={[60, 44, 70, 52]} />
					) : detailError ? (
						<Banner
							actions={
								<Button
									disabled={!sidecarReady}
									icon={<RefreshCw />}
									onClick={() => setDetailAttempt(attempt => attempt + 1)}
									size="sm"
									title={notConnected}
								>
									{t("common.retry")}
								</Button>
							}
							title={t("settings.skills.detailFailed")}
							variant="danger"
						>
							<ErrorDetail error={detailError} />
						</Banner>
					) : detail ? (
						<div className="skills-preview-pane min-h-0 flex-1 overflow-y-auto border-t border-(--sc-divider) pt-3 text-sc-md">
							<MarkdownRenderer content={detail.body} />
						</div>
					) : null}
				</div>
			</div>
		);
	} else {
		detailBody = (
			<EmptyState className="h-full" icon={<BookOpen />} size="sm" title={t("settings.skills.selectHint")} />
		);
	}

	// Nothing installed: one empty state carries the only "New" action, not an empty list beside an empty preview.
	const nothingInstalled = !error && !loading && skills.length === 0 && !editor;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				{nothingInstalled ? null : (
					<>
						<div className="w-44">
							<Select
								aria-label={t("settings.skills.filter.label")}
								controlSize="sm"
								onChange={event => setFilter(event.target.value as SkillFilter)}
								options={FILTER_OPTIONS.map(option => ({
									value: option,
									label: t(`settings.skills.filter.${option}`),
								}))}
								value={filter}
							/>
						</div>
						<span className="text-sc-xs tabular-nums text-(--sc-text-muted)">
							{t("settings.skills.count", { shown: visible.length, total: skills.length })}
						</span>
					</>
				)}
				<span className="flex-1" />
				<IconButton
					disabled={!sidecarReady || !routeReady}
					icon={<RefreshCw />}
					label={notConnected ?? t("settings.skills.refresh")}
					loading={loading}
					onClick={() => void loadSkills()}
					size="sm"
				/>
				{nothingInstalled ? null : (
					<Button disabled={!sidecarReady || !routeReady} icon={<Plus />} onClick={startCreate} size="sm">
						{t("settings.skills.new")}
					</Button>
				)}
			</div>

			{nothingInstalled ? (
				<EmptyState
					actions={
						<Button disabled={!sidecarReady || !routeReady} icon={<Plus />} onClick={startCreate} size="sm">
							{t("settings.skills.new")}
						</Button>
					}
					className="rounded-(--sc-radius-lg) border border-(--sc-border-subtle)"
					icon={<BookOpen />}
					title={t("settings.skills.none")}
				/>
			) : (
				<div className="skills-master-detail overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
					<aside className="skills-list-pane min-h-0">{listBody}</aside>
					<section
						aria-label={selected?.name ?? t("settings.skills.title")}
						className="skills-detail-pane min-w-0 overflow-y-auto p-5"
					>
						{detailBody}
					</section>
				</div>
			)}

			<ConfirmDialog
				busy={busyName !== null}
				confirmLabel={t("common.delete")}
				message={t("settings.skills.deleteConfirm")}
				onCancel={() => setDeleteArmed(false)}
				onConfirm={() => void remove()}
				open={deleteArmed && selected?.managed === true}
				title={t("settings.skills.deleteTitle")}
			/>
		</div>
	);
}
