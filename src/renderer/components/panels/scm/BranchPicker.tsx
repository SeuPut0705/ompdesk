/**
 * Branch chip and picker for the Changes panel: the current branch (or a
 * detached HEAD), a filter, local then remote branches newest first, and per
 * branch merge into the current one, rename and delete. Creating takes the
 * filter text; Enter in the filter creates only when no branch it matches can be
 * switched to, else it goes to that branch. A branch another worktree holds says
 * where and cannot be switched to.
 */
import { GitBranch, GitMerge, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RpcGitBranch } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { useFocusedScope } from "../../../lib/focused-scope";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { lastRead, rememberRead } from "../../../lib/last-read";
import type { TabRpc } from "../../../lib/tab-rpc";
import { Button, ConfirmDialog, InlineNotice, MenuButton, Popover, SearchField, SkeletonRows } from "../../common";
import { PANEL_ROW } from "../PanelChrome";
import type { NameRequest } from "./NameDialog";
import type { ScmRunner } from "./use-scm-action";

export function BranchPicker({
	rpc,
	branch,
	disabled,
	runner,
	requestName,
}: {
	rpc: TabRpc;
	branch: string | null;
	disabled?: boolean;
	runner: ScmRunner;
	requestName: (request: NameRequest) => void;
}) {
	const t = useT();
	const anchorRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const { device, cwd } = useFocusedScope();
	const branchesKey = `scm:branches:${cwd}`;
	// The branches seen last time are there when the popover opens; the read below replaces them in place.
	const [list, setList] = useState<RpcGitBranch[] | null>(() => lastRead<RpcGitBranch[]>(device, branchesKey) ?? null);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<{ name: string; force: boolean } | null>(null);

	useEffect(() => {
		if (!open) return;
		let active = true;
		setList(lastRead<RpcGitBranch[]>(device, branchesKey) ?? null);
		setError(null);
		void rpc
			.command({ type: "git_branches" })
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				const data = response.data as RpcGitBranch[];
				setList(data);
				rememberRead(device, branchesKey, data);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			});
		return () => {
			active = false;
		};
	}, [open, rpc, t, device, branchesKey]);

	const needle = query.trim().toLocaleLowerCase();
	const shown = useMemo(
		() => (list ?? []).filter(item => item.name.toLocaleLowerCase().includes(needle)),
		[list, needle],
	);
	const local = shown.filter(item => !item.remote);
	const remote = shown.filter(item => item.remote);
	const exact = (list ?? []).some(item => !item.remote && item.name === query.trim());

	const close = () => {
		setOpen(false);
		setQuery("");
	};
	const act = (key: string, command: Parameters<ScmRunner["run"]>[1], failure: string, success?: string) => {
		close();
		void runner.run(key, command, { failure, success });
	};

	const listRef = useRef<HTMLDivElement>(null);
	const fieldRef = useRef<HTMLInputElement>(null);
	/** The branches a key can land on, in the order shown: never the current one or one another worktree holds. */
	const rows = (): HTMLButtonElement[] =>
		Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-branch-row]") ?? []).filter(
			row => !row.disabled,
		);
	// ↑/↓ walk the branches; ↑ from the first goes back to the filter. A row's ⋯ stays on Tab.
	const moveBetweenRows = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const all = rows();
		const index = all.indexOf(event.currentTarget);
		if (index < 0) return;
		event.preventDefault();
		const next = index + (event.key === "ArrowDown" ? 1 : -1);
		if (next < 0) fieldRef.current?.focus();
		else all[Math.min(next, all.length - 1)]?.focus();
	};

	const row = (item: RpcGitBranch) => {
		const held = item.worktree !== null;
		return (
			<div className="flex items-center gap-1" key={`${item.remote ? "r" : "l"}:${item.name}`}>
				<button
					aria-current={item.current ? "true" : undefined}
					className={cx(PANEL_ROW, "min-w-0 flex-1", item.current && "bg-(--sc-selected)")}
					data-branch-row
					disabled={item.current || held}
					onKeyDown={moveBetweenRows}
					onClick={() =>
						act("switch", { type: "git_branch", action: "switch", name: item.name }, t("scm.branch.switchFailed"))
					}
					title={held ? t("scm.branch.heldBy", { path: item.worktree ?? "" }) : item.name}
					type="button"
				>
					<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
					<span className="min-w-0 flex-1 truncate">{item.name}</span>
					{item.current && (
						<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("scm.branch.current")}</span>
					)}
					{held && <span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("scm.branch.held")}</span>}
				</button>
				{!item.remote && !item.current && (
					<MenuButton
						align="end"
						icon={<MoreHorizontal />}
						items={[
							{
								id: "merge",
								label: t("scm.branch.merge", { name: item.name, into: branch ?? "HEAD" }),
								icon: GitMerge,
								disabled: !branch,
								onSelect: () =>
									act(
										"merge",
										{ type: "git_branch", action: "merge", name: item.name },
										t("scm.branch.mergeFailed"),
										t("scm.branch.merged", { name: item.name }),
									),
							},
							{
								id: "rename",
								label: t("scm.branch.rename"),
								icon: Pencil,
								onSelect: () => {
									close();
									requestName({
										title: t("scm.branch.renameTitle", { name: item.name }),
										label: t("scm.branch.nameLabel"),
										submitLabel: t("scm.branch.rename"),
										initial: item.name,
										onSubmit: newName =>
											void runner.run(
												"rename",
												{ type: "git_branch", action: "rename", name: item.name, newName },
												{ failure: t("scm.branch.renameFailed") },
											),
									});
								},
							},
							{
								id: "delete",
								label: t("scm.branch.delete"),
								icon: Trash2,
								danger: true,
								disabled: held,
								separatorBefore: true,
								onSelect: () => {
									close();
									setDeleting({ name: item.name, force: false });
								},
							},
						]}
						label={t("scm.branch.actions", { name: item.name })}
						size="sm"
					/>
				)}
			</div>
		);
	};

	return (
		<>
			<Button
				aria-expanded={open}
				aria-haspopup="dialog"
				className="min-w-0 max-w-[16rem]"
				disabled={disabled}
				icon={<GitBranch />}
				onClick={() => setOpen(value => !value)}
				ref={anchorRef}
				size="sm"
				aria-label={branch ? t("scm.branch.switchTitle", { name: branch }) : t("scm.branch.detached")}
				title={branch ? t("scm.branch.switchTitle", { name: branch }) : t("scm.branch.detached")}
				variant="ghost"
			>
				<span className="truncate">{branch ?? t("scm.branch.detached")}</span>
			</Button>
			<Popover anchorRef={anchorRef} ariaLabel={t("scm.branch.pickerLabel")} onClose={close} open={open}>
				<div className="flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 p-2">
					<SearchField
						autoFocus
						ref={fieldRef}
						controlSize="sm"
						label={t("scm.branch.filter")}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							// A branch the filter matches comes first: Enter or ↓ goes to it (Enter there switches), so a
							// typed part of a name never makes a new branch by itself. Enter creates only when nothing matches.
							const first = rows()[0];
							if ((event.key === "ArrowDown" || event.key === "Enter") && first) {
								event.preventDefault();
								first.focus();
								return;
							}
							if (event.key === "Enter" && query.trim() && !exact) {
								event.preventDefault();
								act(
									"create",
									{ type: "git_branch", action: "create", name: query.trim() },
									t("scm.branch.createFailed"),
								);
							}
						}}
						onValueChange={setQuery}
						placeholder={t("scm.branch.filter")}
						value={query}
					/>
					<div className="max-h-[min(24rem,60dvh)] overflow-y-auto" ref={listRef}>
						{query.trim() && !exact && (
							<button
								className={PANEL_ROW}
								onClick={() =>
									act(
										"create",
										{ type: "git_branch", action: "create", name: query.trim() },
										t("scm.branch.createFailed"),
									)
								}
								type="button"
							>
								<Plus aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
								<span className="min-w-0 flex-1 truncate">
									{t("scm.branch.create", { name: query.trim() })}
								</span>
							</button>
						)}
						{error ? (
							<InlineNotice detail={error} live title={t("scm.branch.loadFailed")} tone="danger" />
						) : list === null ? (
							<SkeletonRows className="py-1" label={t("common.loading")} widths={[60, 44, 70, 52]} />
						) : (
							<>
								{local.length > 0 && (
									<p className="px-2 pt-1 pb-0.5 text-sc-xs text-(--sc-text-muted)">{t("scm.branch.local")}</p>
								)}
								{local.map(row)}
								{remote.length > 0 && (
									<p className="px-2 pt-2 pb-0.5 text-sc-xs text-(--sc-text-muted)">
										{t("scm.branch.remote")}
									</p>
								)}
								{remote.map(row)}
								{shown.length === 0 && !query.trim() && (
									<p className="px-2 py-2 text-sc-sm text-(--sc-text-muted)">{t("scm.branch.none")}</p>
								)}
							</>
						)}
					</div>
				</div>
			</Popover>
			<ConfirmDialog
				confirmLabel={deleting?.force ? t("scm.branch.forceDelete") : t("scm.branch.delete")}
				message={t(deleting?.force ? "scm.branch.forceDeleteBody" : "scm.branch.deleteBody", {
					name: deleting?.name ?? "",
				})}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const target = deleting;
					setDeleting(null);
					if (!target) return;
					void runner
						.run(
							"delete",
							{ type: "git_branch", action: "delete", name: target.name, force: target.force },
							{ failure: t("scm.branch.deleteFailed") },
						)
						.then(result => {
							// `git branch -d` refuses an unmerged branch; offer the forced delete once.
							if (result === undefined && !target.force) setDeleting({ name: target.name, force: true });
						});
				}}
				open={deleting !== null}
				title={t("scm.branch.deleteTitle", { name: deleting?.name ?? "" })}
			/>
		</>
	);
}
