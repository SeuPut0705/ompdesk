/**
 * The right-side sheet showing one subagent's transcript — Agents › Live and
 * the sidebar's subagent rows open the same surface. Render it inside the
 * subagent's session runtime so the transcript reads from the owning tab.
 */

import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { Sheet } from "../common";
import { SubagentTranscript } from "./SubagentTranscript";
import { statusMeta, subagentPrimaryLabel } from "./subagent-graph";

export function SubagentTranscriptSheet({ agent, onClose }: { agent: SubagentSnapshot | null; onClose: () => void }) {
	const t = useT();
	return (
		<Sheet
			description={agent ? `${agent.agent} · ${t(statusMeta(agent.status).labelKey)}` : undefined}
			onClose={onClose}
			open={agent !== null}
			size="lg"
			title={agent ? subagentPrimaryLabel(agent) : ""}
		>
			{agent && <SubagentTranscript agent={agent} />}
		</Sheet>
	);
}
