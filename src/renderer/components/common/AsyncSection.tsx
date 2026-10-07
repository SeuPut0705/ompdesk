/**
 * One async section, one truthful state.
 *
 * Every list/detail pane that reads from the sidecar has the same four states,
 * and the interesting rule is their precedence: a failed request is not an
 * empty collection, and a reload is not an initial load. Getting that backwards
 * is what made a dead sidecar look like "no model roles configured" and a
 * failed provider read look like "you are not signed in".
 *
 * When the section already has rows, the caller passes `hasData` and renders
 * them as children: the error then degrades to a banner over stale data instead
 * of replacing it.
 */

import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./Spinner";

export interface AsyncSectionProps {
	loading: boolean;
	/** Rows from the last successful load are still on screen. */
	hasData?: boolean;
	error: string | null;
	/** Whether the loaded collection is empty; never consulted while `error` is set. */
	empty?: boolean;
	onRetry?: () => void;
	loadingLabel?: string;
	/** Heading above the error message. */
	errorTitle?: string;
	/** Banner label when stale rows stay visible under the error. */
	staleLabel?: string;
	emptyLabel?: string;
	retryLabel?: string;
	/** Box for the full-panel states; compact rows pass their own padding. */
	className?: string;
	children: ReactNode;
}

const PLAIN_STATE_CLASS = "flex flex-col items-center justify-center gap-2.5 px-4 py-6 text-center";

export function AsyncSection({
	loading,
	hasData = false,
	error,
	empty = false,
	onRetry,
	loadingLabel,
	errorTitle,
	staleLabel,
	emptyLabel,
	retryLabel,
	className,
	children,
}: AsyncSectionProps) {
	const t = useT();
	const box = className ?? "h-64";
	const retry = retryLabel ?? t("common.retry");
	const retryButton = onRetry && (
		<Button icon={<RefreshCw />} onClick={onRetry} size="sm" variant="secondary">
			{retry}
		</Button>
	);

	if (loading && !hasData) {
		return (
			<div aria-busy className={cx(PLAIN_STATE_CLASS, box)}>
				<Spinner size="md" />
				{loadingLabel && <span className="text-sc-sm text-(--sc-text-muted)">{loadingLabel}</span>}
			</div>
		);
	}
	if (error && !hasData) {
		return (
			<EmptyState
				actions={retryButton}
				className={box}
				description={errorTitle ? <span role="alert">{error}</span> : undefined}
				icon={<AlertTriangle />}
				size="sm"
				title={errorTitle ? errorTitle : <span role="alert">{error}</span>}
			/>
		);
	}
	if (empty && !error) {
		return <EmptyState className={box} icon={<Inbox />} size="sm" title={emptyLabel ?? ""} />;
	}
	return (
		<>
			{error && (
				<Banner actions={retryButton} className="mb-3" live title={staleLabel} variant="warning">
					{error}
				</Banner>
			)}
			{children}
		</>
	);
}
