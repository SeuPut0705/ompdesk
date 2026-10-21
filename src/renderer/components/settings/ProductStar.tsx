/**
 * Star OMPdesk on GitHub (mixdog's About "Star on GitHub" and its onboarding's
 * last step): reads the signed-in gh account's star on the product repository
 * and stars it on click (`gh api PUT user/starred/…` in main). Without gh or a
 * signed-in account it offers the repository page instead.
 */
import { ExternalLink, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { FEEDBACK_REPO } from "../../../shared/feedback";
import type { GithubStarState } from "../../../shared/github-auth";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { toastError } from "../../stores/toast";
import { Button } from "../common";

export function ProductStar({ size = "sm" }: { size?: "sm" | "md" }) {
	const t = useT();
	const [state, setState] = useState<GithubStarState | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		void window.omp.githubAuth
			.productStar(false)
			.then(next => {
				if (live) setState(next);
			})
			.catch(() => {
				if (live) setState({ starred: null, error: "failed" });
			});
		return () => {
			live = false;
		};
	}, []);

	if (state?.starred === true) {
		return (
			<span
				className="inline-flex items-center gap-1.5 text-sc-sm text-(--sc-text-secondary)"
				data-product-star="starred"
			>
				<Star aria-hidden className="size-3.5 fill-current text-(--sc-warning)" />
				{t("about.starred")}
			</span>
		);
	}
	if (state?.error === "gh_missing" || state?.error === "not_signed_in") {
		return (
			<Button
				data-product-star="page"
				icon={<ExternalLink />}
				onClick={() => openExternal(FEEDBACK_REPO)}
				size={size}
				variant="secondary"
			>
				{t("about.openRepo")}
			</Button>
		);
	}
	return (
		<Button
			data-product-star={state ? "unstarred" : "loading"}
			disabled={!state || busy}
			icon={<Star />}
			loading={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const next = await window.omp.githubAuth.productStar(true);
					setState(next);
					if (next.error) toastError({ title: t("about.starFailed"), error: next.message ?? next.error });
				} catch (cause) {
					toastError({ title: t("about.starFailed"), error: cause });
				} finally {
					setBusy(false);
				}
			}}
			size={size}
			variant="secondary"
		>
			{t("about.star")}
		</Button>
	);
}
