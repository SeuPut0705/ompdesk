/**
 * Settings › Models & accounts › Providers & accounts, grouped by provider (the owner's call,
 * 31 Oct 2026, replacing the flat "one row per account, never grouped" list of 16 Oct: the same
 * mark and long stock name repeated on every account row, and a second account was reachable only
 * from a row's ⋯). One `ProviderGroupItem` per connected provider: its header row is the brand mark,
 * the brand name (stock's full name as the tooltip and in the accessible names), a quiet secondary
 * (the plan stock's name carries, the account count), and at the right a visible "Add account"
 * button for a subscription (hidden for a provider with one credential) beside the provider-level ⋯.
 * A subscription's accounts are `ConnectedRow`s under it, indented, without the mark or the name:
 * account, signed-in state, badges, quota, and only that account's actions. A provider with one
 * credential (API key, env) is the header alone, with its detail and state on the same line.
 * `data-provider-row` is on the group, `data-provider-account` on each account row.
 */

import { CheckCircle2, MoreHorizontal, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { Button, type ContextMenuItem, MenuButton, Spinner } from "../../common";
import { ProviderMark } from "./ProviderMark";
import type { ProviderGroup } from "./provider-groups";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

/** The ⋯ with its busy state, the slot both header and account rows end in. */
function RowMenu({
	menu,
	busy,
	label,
	className = "",
}: {
	menu: ContextMenuItem[];
	busy: boolean;
	label: string;
	className?: string;
}) {
	return (
		<span className={`flex size-(--sc-control-sm) shrink-0 items-center justify-center ${className}`}>
			{busy ? (
				<Spinner size="sm" spin />
			) : (
				menu.length > 0 && <MenuButton align="end" icon={<MoreHorizontal />} items={menu} label={label} size="sm" />
			)}
		</span>
	);
}

function SignedIn() {
	const t = useT();
	return (
		<span className="inline-flex items-center gap-1 text-sc-xs text-(--sc-text-muted)">
			<CheckCircle2 aria-hidden className="size-(--sc-icon-sm) text-(--sc-success)" />
			{t("providers.state.signedIn")}
		</span>
	);
}

/**
 * One provider: its header, and under it (a subscription) the account rows passed as children. A
 * provider with a single credential passes `detail` (and its state) instead of children.
 */
export function ProviderGroupItem({
	group,
	count,
	detail,
	detailTitle,
	badges,
	onAdd,
	addDisabled = false,
	menu,
	busy = false,
	children,
	after,
}: {
	group: ProviderGroup;
	/** Accounts held; the count shows beside the name only above one. */
	count?: number;
	/** A single-credential provider's detail ("API key · 595 models"), or a note while accounts load. */
	detail?: string;
	detailTitle?: string;
	badges?: ReactNode;
	/** Present for a subscription: the header's "Add account". */
	onAdd?: () => void;
	addDisabled?: boolean;
	/** The provider's own actions. */
	menu: ContextMenuItem[];
	busy?: boolean;
	/** The account rows (`ConnectedRow`s and notices) of a subscription. */
	children?: ReactNode;
	/** Rendered inside the group after its account list (a confirm dialog). */
	after?: ReactNode;
}) {
	const t = useT();
	const { provider, shortName, fullName, plan } = group;
	const single = group.kind === "single";
	const secondary = detail ?? plan;
	const countText = count !== undefined && count > 1 ? t("providers.accounts.count", { count }) : null;
	return (
		<li className="@container py-1.5" data-provider-row={provider.id}>
			<div className="flex min-h-8 items-center gap-x-3 px-2.5" data-provider-head>
				<div className="flex min-w-0 flex-1 items-center gap-2.5" title={fullName}>
					<ProviderMark provider={provider} />
					<span className="flex min-w-0 flex-1 items-baseline gap-2">
						<span
							className="max-w-[60%] shrink-0 truncate text-sc-md font-medium text-(--sc-text)"
							data-provider-name
						>
							{shortName}
						</span>
						{secondary && (
							<span
								className={`min-w-0 truncate text-sc-sm text-(--sc-text-muted)${detail === undefined ? " hidden @md:inline" : ""}`}
								data-account-label
								title={detailTitle}
							>
								{secondary}
							</span>
						)}
						{countText && (
							<span className="shrink-0 text-sc-sm whitespace-nowrap text-(--sc-text-muted)" data-account-count>
								{secondary && detail === undefined ? (
									<>
										<span className="hidden @md:inline">· </span>
										{countText}
									</>
								) : (
									countText
								)}
							</span>
						)}
					</span>
				</div>
				{single && detail !== undefined && (
					<span className="flex shrink-0 items-center gap-1.5">
						<SignedIn />
						{badges}
					</span>
				)}
				{onAdd && (
					<Button
						aria-label={t("providers.accounts.addTo", { provider: fullName })}
						data-provider-add={provider.id}
						disabled={addDisabled}
						icon={<Plus />}
						onClick={onAdd}
						size="sm"
						variant="ghost"
					>
						{t("providers.accounts.addShort")}
					</Button>
				)}
				<RowMenu busy={busy} label={t("providers.row.actions", { name: fullName })} menu={menu} />
			</div>
			{children && (
				<ul aria-label={fullName} className="flex flex-col" data-provider-accounts>
					{children}
				</ul>
			)}
			{after}
		</li>
	);
}

/** One account of a subscription, indented under its header: no mark, no provider name. */
export function ConnectedRow({
	account,
	accountTitle,
	actionName,
	badges,
	quota,
	below,
	menu,
	busy = false,
	rowProps,
}: {
	/** The account: an email or id. */
	account: string;
	accountTitle?: string;
	/** Names the ⋯ ("{provider} {account}"). */
	actionName: string;
	/** State marks after "Signed in": in use, limited. */
	badges?: ReactNode;
	/** The account's quota gauges (QuotaCell). */
	quota?: ReactNode;
	/** Full-width detail under the row (a reset pass). */
	below?: ReactNode;
	/** This account's actions; no menu when empty. */
	menu: ContextMenuItem[];
	/** An action is running for this row. */
	busy?: boolean;
	rowProps?: DataAttributes;
}) {
	const t = useT();
	return (
		<li {...rowProps} className="@container py-1">
			<div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 pr-2.5 pl-[calc(0.625rem+1.25rem+0.625rem)]">
				<span
					className="order-1 min-w-0 flex-1 basis-24 truncate text-sc-sm text-(--sc-text)"
					data-account-label
					title={accountTitle}
				>
					{account}
				</span>
				<span className="order-3 flex shrink-0 basis-full flex-wrap items-center gap-1.5 @xl:order-2 @xl:basis-auto">
					<SignedIn />
					{badges}
				</span>
				{quota && <div className="order-4 basis-full @xl:order-3 @xl:basis-auto">{quota}</div>}
				<RowMenu
					busy={busy}
					className="order-2 @xl:order-4"
					label={t("providers.row.actions", { name: actionName })}
					menu={menu}
				/>
			</div>
			{below && <div className="pt-1 pr-2.5 pl-[calc(0.625rem+1.25rem+0.625rem)]">{below}</div>}
		</li>
	);
}
