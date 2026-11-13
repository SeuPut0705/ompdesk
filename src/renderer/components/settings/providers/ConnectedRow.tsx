/**
 * Settings › Models & accounts › Providers & accounts, grouped by provider (the owner's call,
 * 31 Oct 2026, replacing the flat "one row per account, never grouped" list of 16 Oct: the same
 * mark and long stock name repeated on every account row, and a second account was reachable only
 * from a row's ⋯). One `ProviderGroupItem` per connected provider: its header row is the brand mark,
 * the brand name (stock's full name as the tooltip and in the accessible names), a quiet secondary
 * (the plan stock's name carries, the account count), and at the right a visible "Add account"
 * button for a subscription (hidden for a provider with one credential) beside the provider-level ⋯.
 * A subscription's accounts are `ConnectedRow`s under it, indented, without the mark or the name:
 * account, state badges, quota, the credits it has left, a reset pass, and only that account's actions, on one line
 * where the list is wide (the quota and the credits under the account where it is not). No row says it is signed in:
 * every provider and account listed is. A provider with one credential (API key, env) is the
 * header alone, with its detail and any abnormal-state badges on the same line.
 * `data-provider-row` is on the group, `data-provider-account` on each account row.
 * The sidebar's usage block draws the same two components `compact` (layout/sidebar/SidebarUsage.tsx): a head that
 * folds its accounts (`fold`), no ⋯ (`menu` absent), the address wrapped whole, and a `reason` line under the quota.
 */

import { MoreHorizontal, Plus } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { Button, Collapse, type ContextMenuItem, DisclosureButton, MenuButton, Spinner } from "../../common";
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
	fold,
	compact = false,
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
	/** The provider's own actions; no ⋯ slot at all when absent. */
	menu?: ContextMenuItem[];
	busy?: boolean;
	/** The head folds the account list: `open` and its toggle (the sidebar remembers it). */
	fold?: { open: boolean; onToggle: () => void };
	/** A dense list (the sidebar): a lower head and a smaller name. */
	compact?: boolean;
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
	const list = children && (
		<ul aria-label={fullName} className="flex flex-col" data-provider-accounts>
			{children}
		</ul>
	);
	const identity = (
		<>
			<ProviderMark provider={provider} />
			<span className="flex min-w-0 flex-1 items-baseline gap-2">
				<span
					className={`max-w-[60%] shrink-0 truncate font-medium text-(--sc-text) ${compact ? "text-sc-sm" : "text-sc-md"}`}
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
		</>
	);
	return (
		<li className={`@container ${compact ? "py-0.5" : "py-1.5"}`} data-provider-row={provider.id}>
			<div className={`flex ${compact ? "min-h-7" : "min-h-8"} items-center gap-x-3 px-2.5`} data-provider-head>
				{fold ? (
					<DisclosureButton
						chevron="end"
						className="min-w-0 flex-1 gap-2.5 rounded-(--sc-radius-md)"
						data-provider-fold={provider.id}
						onToggle={fold.onToggle}
						open={fold.open}
						title={fullName}
					>
						{identity}
					</DisclosureButton>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-2.5" title={fullName}>
						{identity}
					</div>
				)}
				{single && detail !== undefined && badges && (
					<span className="flex shrink-0 items-center gap-1.5">{badges}</span>
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
				{menu && (
					<RowMenu busy={busy} label={t("providers.row.actions", { name: fullName })} menu={menu} />
				)}
			</div>
			{list && (fold ? <Collapse open={fold.open}>{list}</Collapse> : list)}
			{after}
		</li>
	);
}

/**
 * One account of a subscription, indented under its header: no mark, no provider name. From 42 rem of list (`@2xl`:
 * Settings in the default 1280 px window), one line:
 * account and badges, quota, credits, reset pass, ⋯; narrower, the quota takes the line under them and the credits
 * the line under that, so neither pushes the ticket or the ⋯ off the first line. The quota, credits and reset-pass
 * slots keep their width in every row of the list (`quota`, `credits` and `pass` may be empty), so the same window
 * stands in the same column down the list.
 */
export function ConnectedRow({
	account,
	accountSuffix,
	accountTitle,
	actionName,
	badges,
	quota,
	quotaColumns = 0,
	credits,
	pass,
	menu,
	busy = false,
	compact = false,
	reason,
	rowProps,
}: {
	/** The account: an email or id. */
	account: string;
	/** What tells this account from another of the provider with the same address ("team", "pro"), muted after it. */
	accountSuffix?: string;
	accountTitle?: string;
	/** Names the ⋯ ("{provider} {account}"); the account's own name when absent. */
	actionName?: string;
	/** State marks after the account: in use, and a limit no gauge shows. */
	badges?: ReactNode;
	/** The account's quota cell (QuotaCell); renders nothing for an account without a report. */
	quota?: ReactNode;
	/** Gauge columns the provider's accounts share (0: none reports a quota): the quota slot's width on the one-line row. */
	quotaColumns?: number;
	/** What the account has left to spend, `null` for an account without; `undefined` when no account of the list has any. */
	credits?: ReactNode;
	/** The account's reset pass, `null` for an account without one; `undefined` when no account of the provider has any. */
	pass?: ReactNode;
	/** This account's actions; no menu when empty, and no ⋯ slot at all when absent (a list with nothing to do per account). */
	menu?: ContextMenuItem[];
	/** An action is running for this row. */
	busy?: boolean;
	/** A list too narrow for a row to give its account a line of its own: the address wraps whole instead of ending in an ellipsis. */
	compact?: boolean;
	/** One line of why the session is on this account, under the quota (the rotation's reason); nothing when absent. */
	reason?: ReactNode;
	rowProps?: DataAttributes;
}) {
	const t = useT();
	return (
		<li {...rowProps} className={`@container ${compact ? "py-1" : "py-1.5"}`}>
			<div
				className={`flex flex-wrap items-start gap-x-3 gap-y-1.5 pr-2.5 ${compact ? "pl-[calc(0.625rem+1.25rem)]" : "pl-[calc(0.625rem+1.25rem+0.625rem)]"}`}
			>
				<span
					className={`order-1 flex ${compact ? "min-h-6" : "min-h-(--sc-control-sm)"} min-w-0 flex-1 basis-24 items-center gap-2`}
				>
					<span
						className={`min-w-0 text-sc-sm text-(--sc-text) ${compact ? "[overflow-wrap:anywhere]" : "truncate"}`}
						data-account-label
						title={accountTitle}
					>
						{account}
						{accountSuffix && (
							<span className="text-(--sc-text-muted)" data-account-suffix>
								{" "}
								{accountSuffix}
							</span>
						)}
					</span>
					{badges}
				</span>
				{quotaColumns > 0 && (
					// 3px: the 22px bar on the centre line of the 28px controls beside it. An account without a report
					// keeps the slot on the one-line row and takes no line of its own under it.
					<div
						className="order-4 basis-full empty:hidden @2xl:order-2 @2xl:w-[calc(var(--omp-quota-columns)*6.5rem)] @2xl:shrink-0 @2xl:basis-auto @2xl:pt-[3px] @2xl:empty:block"
						style={{ "--omp-quota-columns": quotaColumns } as CSSProperties}
					>
						{quota}
					</div>
				)}
				{credits !== undefined && (
					<span
						className="order-5 flex basis-full empty:hidden @2xl:order-3 @2xl:min-h-(--sc-control-sm) @2xl:w-[6.5rem] @2xl:shrink-0 @2xl:basis-auto @2xl:items-center @2xl:justify-end @2xl:empty:flex"
						data-account-credits-slot
					>
						{credits}
					</span>
				)}
				{pass !== undefined && (
					<span
						className="order-2 flex shrink-0 justify-end empty:hidden @2xl:order-4 @2xl:w-[3.75rem] @2xl:empty:flex"
						data-account-pass
					>
						{pass}
					</span>
				)}
				{menu && (
					<RowMenu
						busy={busy}
						className="order-3 @2xl:order-5"
						label={t("providers.row.actions", { name: actionName ?? account })}
						menu={menu}
					/>
				)}
				{reason && (
					<span className="order-6 basis-full text-sc-xs break-words text-(--sc-text-muted)" data-account-reason>
						{reason}
					</span>
				)}
			</div>
		</li>
	);
}
