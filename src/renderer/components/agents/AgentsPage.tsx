/**
 * Agents destination: a full page in the main area with
 * four tabs — Live (the session's subagents), Definitions (enable, model and
 * prewalk overrides per agent), Pull requests and GitHub (issues, Actions,
 * releases, notifications, repositories). The active tab lives in the
 * ui store (`agentsTab`, `openAgents(tab)`) so ⌥A, ⌥P, the palette, menus and
 * links land on the right one.
 */

import { useT } from "../../lib/i18n";
import { useSubagentsStore } from "../../stores/subagents";
import { type AgentsTab, useUiStore } from "../../stores/ui";
import { PageLayout, Tabs } from "../common";
import { isLiveSubagentStatus } from "../panels/subagent-graph";
import { AgentDefinitions } from "./AgentDefinitions";
import { GithubCenter } from "./github/GithubCenter";
import { LiveAgents } from "./LiveAgents";
import { PullRequests } from "./PullRequests";

const TAB_LABEL_KEY: Record<AgentsTab, string> = {
	live: "agents.tabs.live",
	definitions: "agents.tabs.definitions",
	prs: "agents.tabs.prs",
	github: "agents.tabs.github",
};

export function AgentsPage() {
	const t = useT();
	const tab = useUiStore(s => s.agentsTab);
	const openAgents = useUiStore(s => s.openAgents);
	const runningCount = useSubagentsStore(s => {
		let count = 0;
		for (const agent of s.subagents.values()) if (isLiveSubagentStatus(agent.status)) count += 1;
		return count;
	});

	return (
		<PageLayout
			body={tab === "prs" || tab === "github" ? "fill" : "scroll"}
			panelLabel={t(TAB_LABEL_KEY[tab])}
			tabs={
				<Tabs
					activeId={tab}
					ariaLabel={t("agents.title")}
					onChange={id => openAgents(id as AgentsTab)}
					tabs={(Object.keys(TAB_LABEL_KEY) as AgentsTab[]).map(id => ({
						id,
						label: t(TAB_LABEL_KEY[id]),
						badge: id === "live" && runningCount > 0 ? runningCount : undefined,
					}))}
				/>
			}
			title={t("agents.title")}
		>
			{tab === "live" && <LiveAgents />}
			{tab === "definitions" && <AgentDefinitions />}
			{tab === "prs" && <PullRequests />}
			{tab === "github" && <GithubCenter />}
		</PageLayout>
	);
}
