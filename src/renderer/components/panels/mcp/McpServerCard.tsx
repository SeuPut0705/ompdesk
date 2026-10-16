/**
 * MCP server row (Settings › Extensions › MCP servers): scope and transport
 * badges, the stdio command / http(sse) URL target line, connection status,
 * tool count, and auth-state badge. The action menu (MenuButton) keeps
 * enable/disable/reconnect/remove (remove is disabled for discovered-only
 * servers, which live in no writable config) plus "test connection" (inline
 * per-row result) and "re-authorize" (the existing extension_ui
 * open_url/input dialogs render the OAuth flow; this row only tracks the
 * in-flight state and offers Cancel via rpc.mcpReauthCancel).
 *
 * State, RPC dispatch and the remove confirmation live in the parent MCP tab
 * (settings/ExtensionsSection) — this component is pure presentation, so
 * tests can SSR-render it. Rows are hairline-divided by the parent list.
 */

import { FlaskConical, KeyRound, Lock, MoreHorizontal, Plug, Power, RefreshCw, Trash2 } from "lucide-react";
import type { RpcMcpServerInfo } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { Badge, type BadgeVariant, Button, type ContextMenuItem, MenuButton, Spinner } from "../../common";
import { McpTestResultView, type McpTestView } from "./McpFeedback";

export type McpCardAction = "enable" | "disable" | "reconnect" | "remove" | "test" | "reauth";

/** Reauth in-flight phases; "cancelling" disables the cancel button. */
export type McpReauthPhase = "running" | "cancelling";

/** MCP connection status → badge color (connected / connecting pulse / dim). */
export const MCP_STATUS_VARIANT: Record<RpcMcpServerInfo["status"], BadgeVariant> = {
	connected: "success",
	connecting: "info",
	disconnected: "muted",
};

/** MCP auth state → badge color (none renders no badge at all). */
export const MCP_AUTH_BADGE_VARIANT: Record<NonNullable<RpcMcpServerInfo["authState"]>, BadgeVariant> = {
	none: "muted",
	authorized: "success",
	expired: "warning",
	required: "error",
};

/** authState badge for the C1 wire field; falls back to the legacy authed lock. */
function AuthBadge({ server }: { server: RpcMcpServerInfo }) {
	const t = useT();
	if (server.authState && server.authState !== "none") {
		return (
			<Badge dot variant={MCP_AUTH_BADGE_VARIANT[server.authState]}>
				{t(`mcp.card.auth.${server.authState}`)}
			</Badge>
		);
	}
	if (server.authed) {
		return (
			<span className="inline-flex shrink-0 text-(--sc-text-muted)" title={t("extPanel.authed")}>
				<Lock aria-hidden="true" className="size-(--sc-icon-sm)" />
				<span className="sr-only">{t("extPanel.authed")}</span>
			</span>
		);
	}
	return null;
}

export interface McpServerCardProps {
	server: RpcMcpServerInfo;
	/** Enable state with the parent's optimistic overlay applied. */
	enabled: boolean;
	/** This row's mutation is in flight. */
	busy: boolean;
	/** Another row's mutation is in flight (one at a time), or the session is not ready. */
	disabled: boolean;
	/** mcpTest in flight for this server. */
	testing: boolean;
	/** Latest inline test result (dismissible). */
	testView: McpTestView | null;
	/** Reauth phase while a re-authorize flow is in flight, else null. */
	reauth: McpReauthPhase | null;
	onMenuAction: (action: McpCardAction) => void;
	onDismissTest: () => void;
	onReauthCancel: () => void;
}

export function McpServerCard({
	server,
	enabled,
	busy,
	disabled,
	testing,
	testView,
	reauth,
	onMenuAction,
	onDismissTest,
	onReauthCancel,
}: McpServerCardProps) {
	const t = useT();

	// stdio shows the command; http/sse the URL; fall back to whichever exists.
	const target = (server.transport === "stdio" ? server.command : server.url) ?? server.command ?? server.url;

	const items: ContextMenuItem[] = [
		{
			id: "toggle",
			label: enabled ? t("extPanel.action.disable") : t("extPanel.action.enable"),
			icon: Power,
			onSelect: () => onMenuAction(enabled ? "disable" : "enable"),
		},
		{
			id: "reconnect",
			label: t("extPanel.action.reconnect"),
			icon: RefreshCw,
			disabled: !enabled || server.status === "connecting",
			onSelect: () => onMenuAction("reconnect"),
		},
		{
			id: "test",
			label: t("mcp.action.test"),
			icon: FlaskConical,
			disabled: testing,
			onSelect: () => onMenuAction("test"),
		},
		{
			id: "reauth",
			label: t("mcp.action.reauth"),
			icon: KeyRound,
			disabled: reauth !== null,
			onSelect: () => onMenuAction("reauth"),
		},
		{
			id: "remove",
			label: t("extPanel.action.remove"),
			icon: Trash2,
			danger: true,
			disabled: !server.scope,
			disabledReason: server.scope ? undefined : t("mcp.card.removeUnavailable"),
			onSelect: () => onMenuAction("remove"),
		},
	];

	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-center gap-2">
				<Plug aria-hidden className="size-(--sc-icon-md) shrink-0 text-(--sc-text-muted)" />
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						<span className="font-mono text-sc-md font-medium text-(--sc-text)">{server.name}</span>
						<Badge variant="default">{server.transport}</Badge>
						{server.scope && <Badge variant="muted">{t(`mcp.card.scope.${server.scope}`)}</Badge>}
						{!enabled && <Badge variant="muted">{t("extPanel.disabled")}</Badge>}
						<AuthBadge server={server} />
					</div>
					{target && (
						<span className="block truncate font-mono text-sc-xs text-(--sc-text-muted)" title={target}>
							{target}
						</span>
					)}
				</div>
				<span className="shrink-0 text-sc-sm tabular-nums text-(--sc-text-muted)">
					{t("extPanel.tools", { count: server.toolCount })}
				</span>
				<Badge dot pulse={server.status === "connecting"} variant={MCP_STATUS_VARIANT[server.status]}>
					{t(`extPanel.status.${server.status}`)}
				</Badge>
				{busy ? (
					<span className="flex size-(--sc-control-sm) shrink-0 items-center justify-center">
						<Spinner size="sm" />
					</span>
				) : (
					<MenuButton
						align="end"
						disabled={disabled}
						icon={<MoreHorizontal />}
						items={items}
						label={t("extPanel.mcp.menu")}
						size="sm"
					/>
				)}
			</div>
			{(testing || testView) && <McpTestResultView onDismiss={onDismissTest} testing={testing} view={testView} />}
			{reauth !== null && (
				<div className="flex items-center gap-2" role="status">
					<Spinner size="sm" />
					<span className="min-w-0 flex-1 text-sc-sm text-(--sc-text-muted)">{t("mcp.reauth.running")}</span>
					<Button disabled={reauth === "cancelling"} onClick={onReauthCancel} size="sm" variant="ghost">
						{reauth === "cancelling" ? t("mcp.reauth.cancelling") : t("mcp.reauth.cancel")}
					</Button>
				</div>
			)}
		</div>
	);
}
