import { useTabRpc } from "../../lib/tab-rpc";
/**
 * Branch picker: lists the current session's user messages (via
 * rpc.getBranchMessages) and branches the session from the chosen entry via
 * rpc.branch(entryId). Follows the ModelPicker overlay pattern.
 */

import { GitBranch, RotateCw } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import { branchSessionFromEntry } from "../../lib/messages";
import { useSessionStore } from "../../stores/session";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice, Kbd, Modal, OptionRow, SearchField, SkeletonRows, Spinner } from "../common";

interface BranchEntry {
	entryId: string;
	text: string;
}

export function BranchPickerDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const open = useUiStore(state => state.branchPickerOpen);
	const close = useUiStore(state => state.closeBranchPicker);
	const sidecarReady = useSessionStore(state => state.status) === "ready";

	const [query, setQuery] = useState("");
	const [entries, setEntries] = useState<BranchEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [branching, setBranching] = useState<string | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();

	const [attempt, setAttempt] = useState(0);

	/* The retry button's bump is the only reason this effect re-runs; nothing inside
	   reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setLoading(true);
		setError(null);
		setBranching(null);
		if (!sidecarReady) {
			setError({ message: t("modelPicker.notConnected") });
			setLoading(false);
			return;
		}
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
		let cancelled = false;
		void tabRpc
			.getBranchMessages()
			.then(response => {
				if (cancelled) return;
				if (response.success) {
					const data = response.data as { messages?: BranchEntry[] } | undefined;
					setEntries(data?.messages ?? []);
				} else {
					setError(inlineFailure(response, t("branchPicker.loadFailed")));
				}
			})
			.catch(cause => {
				if (!cancelled) setError(inlineFailure(cause, t("branchPicker.loadFailed")));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, open, sidecarReady, t, tabRpc.getBranchMessages]);

	// Newest first — the RPC returns entries in session order.
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = q ? entries.filter(entry => entry.text.toLowerCase().includes(q)) : entries;
		return [...list].reverse();
	}, [entries, query]);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, filtered.length - 1)));
	}, [filtered.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const select = async (entry: BranchEntry) => {
		if (!sidecarReady || branching !== null) return;
		setBranching(entry.entryId);
		try {
			const result = await branchSessionFromEntry(entry.entryId);
			if (result === "cancelled") {
				toast({ variant: "info", message: t("branchPicker.cancelled") });
				return;
			}
			close();
		} catch (cause) {
			toastError({ title: t("branchPicker.failed"), error: cause });
		} finally {
			setBranching(null);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		const target = listboxTarget(event.key, activeIndex, filtered.length, { wrap: false });
		if (target !== null) {
			event.preventDefault();
			setActiveIndex(target);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const entry = filtered[activeIndex];
			if (entry) void select(entry);
		}
	};

	// role="listbox" only when option rows actually render (loading / error /
	// empty states are plain status blocks, not listbox children).
	const showOptions = !error && !loading && filtered.length > 0;

	return (
		<Modal
			ariaLabel={t("branchPicker.searchLabel")}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2.5 border-b border-(--sc-divider) p-4">
					<div className="min-w-0 flex-1">
						<SearchField
							listbox={{
								id: listboxId,
								activeId: filtered.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined,
							}}
							controlSize="lg"
							label={t("branchPicker.searchLabel")}
							onKeyDown={onKeyDown}
							onValueChange={setQuery}
							placeholder={t("branchPicker.placeholder")}
							ref={inputRef}
							value={query}
						/>
					</div>
					<Kbd shortcut="⎋" />
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<InlineNotice
							action={
								<Button
									icon={<RotateCw />}
									disabled={!sidecarReady}
									onClick={() => setAttempt(count => count + 1)}
									size="sm"
									title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
									variant="secondary"
								>
									{t("common.retry")}
								</Button>
							}
							className="px-3 py-6"
							detail={error.cause}
							live
							title={error.message}
							tone="danger"
						/>
					) : loading ? (
						<SkeletonRows className="py-2" label={t("branchPicker.loading")} widths={[60, 44, 70, 52]} />
					) : filtered.length === 0 ? (
						<div className="py-10 text-center text-sc-sm text-(--sc-text-muted)">
							{entries.length === 0 ? t("branchPicker.empty") : t("branchPicker.noMatch", { query })}
						</div>
					) : (
						filtered.map((entry, index) => {
							const isActive = index === activeIndex;
							return (
								<OptionRow
									active={isActive}
									selected={false}
									data-option-index={index}
									disabled={branching !== null || !sidecarReady}
									title={!sidecarReady ? t("modelPicker.notConnected") : undefined}
									id={`${listboxId}-option-${index}`}
									key={entry.entryId}
									onClick={() => void select(entry)}
									onMouseEnter={() => setActiveIndex(index)}
								>
									<GitBranch aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)">{entry.text}</span>
									{branching === entry.entryId && <Spinner size="sm" spin />}
								</OptionRow>
							);
						})
					)}
				</div>
			</div>
		</Modal>
	);
}
