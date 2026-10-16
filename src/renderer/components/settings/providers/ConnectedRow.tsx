/**
 * One row of Settings › Models & providers › Providers & accounts: brand mark, provider name,
 * the account (email / id / key kind), the sign-in state, the tightest live quota when there is
 * one, and every action behind one overflow menu. A subscription's accounts are one row each,
 * a provider with a key or env credential is one row; the rows are siblings in a single flat
 * list (ProvidersSection), sorted by company, never grouped or collapsed.
 */

import { CheckCircle2, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { type ContextMenuItem, MenuButton, Spinner } from "../../common";
import { ProviderMark } from "./ProviderMark";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export function ConnectedRow({
	provider,
	account,
	accountTitle,
	badges,
	quota,
	below,
	menu,
	busy = false,
	rowProps,
}: {
	provider: { id: string; name: string };
	/** The account: an email, an id, "API key". */
	account?: string;
	accountTitle?: string;
	/** State marks after "Signed in": in use, limited, disabled. */
	badges?: ReactNode;
	/** The tightest quota (QuotaCell). */
	quota?: ReactNode;
	/** Full-width detail under the row (a reset pass). */
	below?: ReactNode;
	/** Actions; no menu when empty. */
	menu: ContextMenuItem[];
	/** An action is running for this row. */
	busy?: boolean;
	rowProps?: DataAttributes;
}) {
	const t = useT();
	return (
		<li {...rowProps} className="@container py-1.5" data-provider-row={provider.id}>
			<div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 px-2.5">
				<div className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
					<ProviderMark provider={provider} />
					<span className="flex min-w-0 flex-1 items-baseline gap-2">
						<span className="max-w-[60%] shrink-0 truncate text-sc-md font-medium text-(--sc-text)">
							{provider.name}
						</span>
						{account !== undefined && (
							<span
								className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)"
								data-account-label
								title={accountTitle}
							>
								{account}
							</span>
						)}
					</span>
				</div>
				<span className="flex shrink-0 items-center gap-1.5">
					<span className="inline-flex items-center gap-1 text-sc-xs text-(--sc-text-muted)">
						<CheckCircle2 aria-hidden className="size-(--sc-icon-sm) text-(--sc-success)" />
						{t("providers.state.signedIn")}
					</span>
					{badges}
				</span>
				{quota}
				<span className="order-3 flex size-(--sc-control-sm) shrink-0 items-center justify-center @xl:order-4">
					{busy ? (
						<Spinner size="sm" />
					) : (
						menu.length > 0 && (
							<MenuButton
								align="end"
								icon={<MoreHorizontal />}
								items={menu}
								label={t("providers.row.actions", { name: [provider.name, account].filter(Boolean).join(" ") })}
								size="sm"
							/>
						)
					)}
				</span>
			</div>
			{below && <div className="pt-1 pr-2.5 pl-[calc(0.625rem+1.25rem+0.625rem)]">{below}</div>}
		</li>
	);
}
