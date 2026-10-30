/**
 * Settings › Updates & about › This computer, after omp's rows: the command-line tools of the connected
 * accounts (main `cli-tools/updater.ts`, contract `shared/cli-update.ts`). One switch (default on), then one
 * row per tool that is installed here: its installed and newest version, how it is updated, the last result or
 * why OMPdesk leaves it alone, and "Update now". OMPdesk only updates what is already installed; the renderer
 * names tools by id and never a command.
 */
import { RefreshCw, Terminal } from "lucide-react";
import { useEffect } from "react";
import { CLI_TOOL_NAMES, type CliToolId, type CliToolState, type CliUpdateState } from "../../../shared/cli-update";
import { isSetupItemId } from "../../../shared/setup";
import { useT } from "../../lib/i18n";
import { useCliUpdateStore } from "../../stores/cli-update";
import { Badge, IconButton, InlineNotice } from "../common";
import { ProviderMark } from "./providers/ProviderMark";
import { SettingsRow } from "./SettingsLayout";

/** The provider whose brand mark identifies a tool (Copilot and gh are GitHub's); Node.js gets a neutral glyph. */
const CLI_PROVIDER: Partial<Record<CliToolId, string>> = {
	claude: "anthropic",
	codex: "openai",
	gemini: "google",
	"cursor-agent": "cursor",
	copilot: "github-copilot",
	gh: "github-copilot",
	"gh-copilot": "github-copilot",
};

export function CliToolMark({ id }: { id: CliToolId }) {
	const provider = CLI_PROVIDER[id];
	return provider ? <ProviderMark provider={{ id: provider, name: CLI_TOOL_NAMES[id] }} /> : <Terminal />;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What the tool is doing, or what the last check found; the failure's own reason goes in a notice below. */
export function cliStatusText(t: Translate, tool: CliToolState, state: Pick<CliUpdateState, "scheduled">): string {
	const name = CLI_TOOL_NAMES[tool.id];
	if (tool.skip) return t(`cliUpdate.skip.${tool.skip}`);
	if (tool.phase === "checking") return t("cliUpdate.status.checking");
	if (tool.phase === "updating") return t("cliUpdate.status.updating");
	const last = tool.last;
	if (!last) return state.scheduled ? t("cliUpdate.status.notChecked") : t("cliUpdate.status.manualOnly");
	switch (last.kind) {
		case "current":
			return t("cliUpdate.status.current");
		case "updated":
			return last.from
				? t("cliUpdate.status.updatedFrom", { from: last.from, to: last.to })
				: t("cliUpdate.status.updated", { to: last.to });
		case "deferred":
			return t("cliUpdate.status.deferred", { name, latest: last.latest });
		case "failed":
			return t(`cliUpdate.failure.${last.failure.reason}`, { name });
	}
}

function versionText(t: Translate, tool: CliToolState): string {
	const installed = tool.installed
		? t("cliUpdate.version.installed", { version: tool.installed })
		: t("cliUpdate.version.unknown");
	return tool.latest ? `${installed} · ${t("cliUpdate.version.latest", { version: tool.latest })}` : installed;
}

/** How OMPdesk updates a tool ("Updated by: Homebrew"), as the quiet badge beside its name. */
export function CliMethodBadge({ tool }: { tool: CliToolState }) {
	const t = useT();
	return (
		<Badge variant="muted">
			{tool.method
				? t("cliUpdate.method", { method: t(`cliUpdate.method.${tool.method}`) })
				: t("cliUpdate.method.none")}
		</Badge>
	);
}

/** "Update now" for one tool: off while it runs or when it is left alone. */
export function CliUpdateNowButton({ tool }: { tool: CliToolState }) {
	const t = useT();
	const updateNow = useCliUpdateStore(store => store.updateNow);
	return (
		<IconButton
			data-testid={`cli-update-now-${tool.id}`}
			disabled={tool.phase !== "idle" || tool.skip !== null}
			icon={<RefreshCw />}
			label={t("cliUpdate.nowFor", { name: CLI_TOOL_NAMES[tool.id] })}
			onClick={() => void updateNow(tool.id)}
			size="sm"
			variant="secondary"
		/>
	);
}

/** What the tool's last update check found (or why it is left alone), on one truncating line. */
export function CliToolStatusText({ tool, state }: { tool: CliToolState; state: CliUpdateState }) {
	const t = useT();
	const text = cliStatusText(t, tool, state);
	return (
		<span className="min-w-0 truncate" data-testid={`cli-status-${tool.id}`} title={text}>
			{text}
		</span>
	);
}

/** The reason the last update failed, quiet under the tool's line; nothing when it did not fail. */
export function CliFailureNotice({ tool }: { tool: CliToolState }) {
	const t = useT();
	const failure = !tool.skip && tool.last?.kind === "failed" ? tool.last.failure : null;
	return failure ? <InlineNotice detail={failure.detail} title={t("cliUpdate.retryNote")} tone="warning" /> : null;
}

function CliToolRow({ tool, state }: { tool: CliToolState; state: CliUpdateState }) {
	const t = useT();
	return (
		<SettingsRow
			badge={<CliMethodBadge tool={tool} />}
			className="min-w-0"
			compactControl
			control={<CliUpdateNowButton tool={tool} />}
			icon={<CliToolMark id={tool.id} />}
			id={`setting-cli-tool-${tool.id}`}
			label={CLI_TOOL_NAMES[tool.id]}
		>
			<div data-cli-tool={tool.id} data-phase={tool.phase}>
				{/* One line: version, then the status; the path rides on hover. */}
				<p className="flex min-w-0 gap-x-2 text-sc-xs text-(--sc-text-muted)" title={tool.path ?? undefined}>
					<span className="shrink-0 text-(--sc-text-secondary)" data-testid={`cli-version-${tool.id}`}>
						{versionText(t, tool)}
					</span>
					<CliToolStatusText state={state} tool={tool} />
				</p>
				<CliFailureNotice tool={tool} />
			</div>
		</SettingsRow>
	);
}

export function CliUpdateRows() {
	const t = useT();
	const state = useCliUpdateStore(store => store.state);
	useEffect(() => {
		void useCliUpdateStore.getState().load();
	}, []);
	if (!state) return null;
	// A tool machine setup lists (GitHub CLI, Node.js) is one row there, with its update method and "Update now".
	const tools = state.tools.filter(tool => !isSetupItemId(tool.id));
	return (
		<>
			{tools.map(tool => (
				<CliToolRow key={tool.id} state={state} tool={tool} />
			))}
			{tools.length === 0 && (
				<p className="py-2 text-sc-sm text-(--sc-text-muted)" data-testid="cli-update-none">
					{t("cliUpdate.none")}
				</p>
			)}
		</>
	);
}
