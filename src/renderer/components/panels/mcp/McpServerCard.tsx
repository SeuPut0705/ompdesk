/**
 * MCP server row (Settings › Extensions › MCP servers): scope and transport
 * badges, the stdio command / http(sse) URL target line, one muted line saying
 * why the server is off (or that it needs a sign-in, or came from another
 * tool's config), and the right-hand columns: the fix as a button (the row's
 * one action), tool count, connection status and the auth-state badge. On a
 * narrow column (a phone) the row stacks: name and badges, target (breaks, two
 * lines), reason, then one meta line with status, tool count and the action.
 * The action menu (MenuButton) keeps
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
import type { ReactNode } from "react";
import type { RpcMcpServerInfo } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { Badge, type BadgeVariant, Button, type ContextMenuItem, MenuButton, SettingInfo, Spinner } from "../../common";
import { McpTestResultView, type McpTestView } from "./McpFeedback";

export type McpCardAction = "enable" | "disable" | "reconnect" | "remove" | "test" | "reauth" | "adopt";

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

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface McpNote {
	texts: string[];
	/** Longer explanation behind an info glyph (never a paragraph). */
	info?: string;
	/** Tooltip of the note's text. */
	title?: string;
	button?: { action: McpCardAction; label: string; icon?: ReactNode };
}

/**
 * The row's one muted line: why a server is off and the fix, else what a sign-in or another tool's config
 * means for it. An enabled row with nothing to say has no line.
 */
function mcpNote(
	server: RpcMcpServerInfo,
	enabled: boolean,
	reauth: McpReauthPhase | null,
	t: Translate,
): McpNote | null {
	if (!enabled) {
		const reason = server.offReason;
		if (!reason) return null;
		switch (reason.kind) {
			case "otherTool":
				return {
					texts: [t("mcp.reason.otherTool", { tool: reason.tool })],
					info: t("mcp.reason.otherTool.info", { tool: reason.tool }),
					button: { action: "adopt", label: t("mcp.action.adopt") },
				};
			case "offInTool":
				return {
					texts: [t("mcp.reason.offInTool", { tool: reason.tool })],
					button: { action: "enable", label: t("mcp.action.turnOn") },
				};
			case "toolOff":
				return { texts: [t("mcp.reason.toolOff", { tool: reason.tool })] };
			case "disabled":
				return {
					texts: [t("mcp.reason.disabled")],
					button: { action: "enable", label: t("mcp.action.turnOn") },
				};
			case "projectConfigOff":
				return { texts: [t("mcp.reason.projectConfigOff")] };
		}
	}
	const texts: string[] = [];
	if (server.alsoIn) texts.push(t("mcp.reason.alsoIn", { tool: server.alsoIn }));
	const authState = server.authState;
	if (reauth === null && (authState === "required" || authState === "expired")) {
		texts.push(t(`mcp.signin.${authState}`));
		return {
			texts,
			title: server.lastError,
			button: { action: "reauth", label: t("mcp.action.signIn"), icon: <KeyRound aria-hidden /> },
		};
	}
	return texts.length > 0 ? { texts } : null;
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
	const note = mcpNote(server, enabled, reauth, t);
	const noteButton = note?.button;

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
		<div className="@container flex flex-col gap-1 py-1.5">
			{/* Wide: icon · name block · action · tools · status · menu, each in its own column so rows line up.
			    Narrow (a phone): the name block and the menu on top, then one meta line (status · tools · action). */}
			<div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 @lg:grid-cols-[auto_minmax(0,1fr)_7.5rem_4.5rem_6.5rem_auto] @lg:items-center">
				<Plug
					aria-hidden
					className="col-start-1 row-start-1 mt-0.5 size-(--sc-icon-md) shrink-0 text-(--sc-text-muted) @lg:mt-0"
				/>
				<div className="col-start-2 row-start-1 flex min-w-0 flex-col">
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						<span className="font-mono text-sc-md font-medium break-all text-(--sc-text)">{server.name}</span>
						<Badge variant="default">{server.transport}</Badge>
						{server.scope && <Badge variant="muted">{t(`mcp.card.scope.${server.scope}`)}</Badge>}
						{!enabled && <Badge variant="muted">{t("extPanel.disabled")}</Badge>}
						<AuthBadge server={server} />
					</div>
					{target && (
						<span
							className="line-clamp-2 font-mono text-sc-xs break-all text-(--sc-text-muted)"
							data-mcp-target
							title={target}
						>
							{target}
						</span>
					)}
					{note && (
						<p
							className="min-w-0 text-sc-xs text-(--sc-text-muted) [--hit-gap-x:6px] [--hit-gap-y:4px]"
							data-mcp-note
						>
							<span title={note.title}>{note.texts.join(" · ")}</span>
							{note.info && (
								<span className="ml-1.5 inline-flex align-middle">
									<SettingInfo text={note.info} />
								</span>
							)}
						</p>
					)}
				</div>
				<div
					className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @lg:contents"
					data-mcp-meta
				>
					{noteButton && (
						<Button
							className="order-3 ml-auto @lg:order-none @lg:col-start-3 @lg:row-start-1 @lg:justify-self-end"
							disabled={disabled || busy}
							icon={noteButton.icon}
							onClick={() => onMenuAction(noteButton.action)}
							size="sm"
							variant="secondary"
						>
							{noteButton.label}
						</Button>
					)}
					<span className="order-2 shrink-0 text-sc-sm tabular-nums text-(--sc-text-muted) @lg:order-none @lg:col-start-4 @lg:row-start-1 @lg:justify-self-end">
						{t("extPanel.tools", { count: server.toolCount })}
					</span>
					<Badge
						className="order-1 @lg:order-none @lg:col-start-5 @lg:row-start-1 @lg:justify-self-start"
						dot
						pulse={server.status === "connecting"}
						variant={MCP_STATUS_VARIANT[server.status]}
					>
						{t(`extPanel.status.${server.status}`)}
					</Badge>
				</div>
				{busy ? (
					<span className="col-start-3 row-start-1 flex size-(--sc-control-sm) shrink-0 items-center justify-center @lg:col-start-6">
						<Spinner size="sm" />
					</span>
				) : (
					<MenuButton
						align="end"
						className="col-start-3 row-start-1 @lg:col-start-6"
						disabled={disabled}
						icon={<MoreHorizontal />}
						items={items}
						label={t("extPanel.mcp.menu", { name: server.name })}
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
