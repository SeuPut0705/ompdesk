import { CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { GithubTarget } from "../../../../shared/github";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { toast, toastError } from "../../../stores/toast";
import { EmptyState } from "../../common";

/** What every section works on: the chosen host and repository (`repoName` null = none known yet). */
export interface GithubSectionProps {
	target: GithubTarget;
	/** `OWNER/NAME` shown and acted on; null when the checkout has no GitHub remote and none was named. */
	repoName: string | null;
	/** A key that changes whenever `target` does, for reloading. */
	targetKey: string;
}

/** One mutation at a time per section: which one runs, and a runner that toasts failure (and success). */
export function useGithubMutation() {
	const [busy, setBusy] = useState<string | null>(null);
	const run = async (id: string, action: () => Promise<unknown>, failedTitle: string, success?: string) => {
		setBusy(id);
		try {
			await action();
			if (success) toast({ variant: "success", message: success });
			return true;
		} catch (error) {
			toastError({ title: failedTitle, error });
			return false;
		} finally {
			setBusy(null);
		}
	};
	return { busy, run };
}

export function GithubToolbar({ children }: { children: ReactNode }) {
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--sc-divider) px-6 py-2 min-[1280px]:px-10">
			{children}
		</div>
	);
}

export function ListButton({
	active,
	onSelect,
	children,
	label,
}: {
	active: boolean;
	onSelect: () => void;
	children: ReactNode;
	label?: string;
}) {
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				aria-label={label}
				className={cx(
					"flex w-full flex-col gap-1 rounded-(--sc-radius-md) px-3 py-2 text-left",
					active ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
				)}
				onClick={onSelect}
				type="button"
			>
				{children}
			</button>
		</li>
	);
}

/** Repository sections without a repository: say how to name one. */
export function NeedsRepo() {
	const t = useT();
	return (
		<EmptyState
			className="flex-1"
			description={t("github.needsRepoHint")}
			icon={<CircleDot />}
			size="sm"
			title={t("github.needsRepo")}
		/>
	);
}

/** A run or job state: completed runs by conclusion, others by status. */
export function RunState({ status, conclusion }: { status: string; conclusion: string }) {
	const t = useT();
	const [Icon, className, key] =
		status !== "completed"
			? [CircleDot, "text-(--sc-warning)", "github.runs.running"]
			: conclusion === "success"
				? [CheckCircle2, "text-(--sc-success)", "github.runs.success"]
				: conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure"
					? [XCircle, "text-(--sc-danger)", "github.runs.failure"]
					: [Circle, "text-(--sc-text-subtle)", "github.runs.other"];
	return (
		<span
			className={cx("flex shrink-0 [&>svg]:size-(--sc-icon-sm)", className)}
			title={t(key, { state: conclusion })}
		>
			<Icon aria-hidden />
			<span className="sr-only">{t(key, { state: conclusion })}</span>
		</span>
	);
}
