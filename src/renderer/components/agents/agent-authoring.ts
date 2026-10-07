/**
 * Agents › Definitions authoring data: where definition files live, which
 * tools omp offers, the configured model roles and installed skills. Loaded
 * on demand (the editor or template gallery opening), not with the list.
 */

import { useCallback, useEffect, useState } from "react";
import type { ModelRolesResult, RpcAgentAuthoringInfo, RpcResponse, RpcSkillsResult } from "../../../shared/rpc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";

export interface AgentRoleOption {
	/** `@role` selector. */
	value: string;
	name: string;
	/** The model the role resolves to, when configured. */
	model?: string;
}

export interface AgentAuthoringData {
	info: RpcAgentAuthoringInfo;
	/** Built-in tools first (omp's order), then MCP/extension tools by name. */
	tools: string[];
	roles: AgentRoleOption[];
	skills: string[];
}

export interface AgentAuthoringState {
	data: AgentAuthoringData | null;
	/** Localized headline plus the raw cause when the authoring data failed to load. */
	error: InlineFailure | null;
	loading: boolean;
	reload: () => void;
}

function dataOf<T>(response: RpcResponse): T {
	if (!response.success) throw new Error(response.error);
	return response.data as T;
}

/** Load authoring data while `enabled`; roles and skills degrade to empty lists on their own failure. */
export function useAgentAuthoring(enabled: boolean): AgentAuthoringState {
	const rpc = useTabRpc();
	const t = useT();
	const [data, setData] = useState<AgentAuthoringData | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [loading, setLoading] = useState(false);

	/** `isCurrent` turns false when the requesting effect is cleaned up. */
	const load = useCallback(
		async (isCurrent: () => boolean) => {
			setLoading(true);
			setError(null);
			try {
				const [response, roles, skills] = await Promise.all([
					rpc.getAgentAuthoring(),
					rpc
						.getModelRoles()
						.then(dataOf<ModelRolesResult>)
						.then(result => result.roles)
						.catch(() => []),
					rpc
						.getSkills()
						.then(dataOf<RpcSkillsResult>)
						.then(result => result.skills)
						.catch(() => []),
				]);
				if (!isCurrent()) return;
				if (!response.success) {
					setError(inlineFailure(response, t("agentStudio.editor.loadFailed")));
					return;
				}
				const authoring = response.data as RpcAgentAuthoringInfo;
				const builtin = new Set(authoring.builtinTools);
				const extra = authoring.registeredTools.filter(tool => !builtin.has(tool)).sort();
				setData({
					info: authoring,
					tools: [...authoring.builtinTools, ...new Set(extra)],
					roles: roles.map(role => ({ value: `@${role.id}`, name: role.name, model: role.model })),
					skills: [...new Set(skills.filter(skill => !skill.hidden).map(skill => skill.name))].sort(),
				});
			} catch (cause) {
				if (isCurrent()) setError(inlineFailure(cause, t("agentStudio.editor.loadFailed")));
			} finally {
				if (isCurrent()) setLoading(false);
			}
		},
		[rpc, t],
	);

	useEffect(() => {
		if (!enabled) return;
		let current = true;
		void load(() => current);
		return () => {
			current = false;
		};
	}, [enabled, load]);

	const reload = useCallback(() => void load(() => true), [load]);
	return { data, error, loading, reload };
}
