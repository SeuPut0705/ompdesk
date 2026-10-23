import { Check, ClipboardCopy } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CopyTarget } from "../../../shared/rpc-types";
import { flattenCopyTargets } from "../../lib/copy-targets";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice, Modal, SkeletonRows } from "../common";

export function CopySelectorDialog() {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const open = useUiStore(state => state.copySelectorOpen);
	const close = useUiStore(state => state.closeCopySelector);
	const [targets, setTargets] = useState<CopyTarget[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setTargets([]);
		setSelectedId(null);
		setCopied(false);
		setError(null);
		if (!sidecarReady) {
			setError({ message: t("common.notConnected") });
			setLoading(false);
			return;
		}
		setLoading(true);
		void tabRpc
			.getCopyTargets()
			.then(response => {
				if (cancelled) return;
				if (!response.success) {
					setError(inlineFailure(response, t("copySelector.loadFailed")));
					return;
				}
				const data = response.data as { targets?: CopyTarget[] } | undefined;
				const next = data?.targets ?? [];
				setTargets(next);
				setSelectedId(flattenCopyTargets(next)[0]?.target.id ?? null);
			})
			.catch(cause => {
				if (!cancelled) setError(inlineFailure(cause, t("copySelector.loadFailed")));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, sidecarReady, t, tabRpc.getCopyTargets]);

	const flat = useMemo(() => flattenCopyTargets(targets), [targets]);
	const selectedIndex = Math.max(
		0,
		flat.findIndex(item => item.target.id === selectedId),
	);
	const selected = flat[selectedIndex]?.target;

	useEffect(() => {
		const row = listRef.current?.querySelector<HTMLElement>(`[data-copy-index="${selectedIndex}"]`);
		row?.scrollIntoView?.({ block: "nearest" });
		// The arrows move the choice; focus follows it from a row so a screen reader reads the row it moved to.
		if (row && listRef.current?.contains(document.activeElement) && document.activeElement !== row) row.focus();
	}, [selectedIndex]);

	const copyTarget = async (target: CopyTarget | undefined): Promise<void> => {
		if (target?.content === undefined) return;
		if (!(await copyText(target.content))) {
			toast({ variant: "error", message: t("copySelector.failed") });
			return;
		}
		setCopied(true);
		toast({ variant: "success", message: target.copyMessage ?? t("copySelector.copied") });
		window.setTimeout(() => close(), 250);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		if (isImeKeyEvent(event)) return;
		if (flat.length === 0) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setSelectedId(flat[(selectedIndex + 1) % flat.length]?.target.id ?? null);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setSelectedId(flat[(selectedIndex - 1 + flat.length) % flat.length]?.target.id ?? null);
		} else if (event.key === "Enter") {
			event.preventDefault();
			void copyTarget(selected);
		}
	};

	return (
		<Modal
			bodyClassName="p-0"
			onClose={close}
			open={open}
			size="lg"
			title={t("copySelector.title")}
			footer={
				<Button
					disabled={selected?.content === undefined}
					icon={copied ? <Check /> : <ClipboardCopy />}
					onClick={() => void copyTarget(selected)}
					size="sm"
					variant="primary"
				>
					{copied ? t("copySelector.copied") : t("copySelector.copy")}
				</Button>
			}
		>
			<div
				className="grid h-[62vh] min-h-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] max-sm:grid-cols-1 max-sm:grid-rows-2"
				onKeyDown={onKeyDown}
			>
				<div
					className="min-h-0 overflow-y-auto border-r border-(--sc-divider) p-2 max-sm:border-r-0 max-sm:border-b"
					ref={listRef}
				>
					{error ? (
						<InlineNotice className="p-4" detail={error.cause} live title={error.message} tone="danger" />
					) : loading ? (
						<SkeletonRows className="py-2" label={t("copySelector.loading")} widths={[60, 44, 70, 52]} />
					) : flat.length === 0 ? (
						<div className="p-8 text-center text-sc-sm text-(--sc-text-muted)">{t("copySelector.empty")}</div>
					) : (
						flat.map((item, index) => (
							<button
								aria-current={index === selectedIndex ? "true" : undefined}
								className={`flex min-h-9 w-full items-center gap-2 rounded-(--sc-radius-md) py-1.5 pr-2 text-left text-sc-md ${
									index === selectedIndex
										? "bg-(--sc-selected) text-(--sc-text)"
										: "text-(--sc-text-secondary) hover:bg-(--sc-hover)"
								}`}
								data-copy-index={index}
								key={item.target.id}
								onClick={() => setSelectedId(item.target.id)}
								onDoubleClick={() => void copyTarget(item.target)}
								style={{ paddingLeft: `calc(var(--sc-space-2) + ${item.depth} * var(--sc-space-4))` }}
								type="button"
							>
								<span className="min-w-0 flex-1 truncate">{item.target.label}</span>
								{item.target.hint && (
									<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{item.target.hint}</span>
								)}
							</button>
						))
					)}
				</div>
				<div className="flex min-h-0 flex-col">
					<div className="min-h-0 flex-1 overflow-auto p-4">
						<div className="mb-2 text-sc-xs font-medium text-(--sc-text-muted)">{t("copySelector.preview")}</div>
						<pre className="whitespace-pre-wrap break-words font-mono text-sc-sm leading-relaxed text-(--sc-text)">
							{selected?.preview ?? ""}
						</pre>
					</div>
				</div>
			</div>
		</Modal>
	);
}
