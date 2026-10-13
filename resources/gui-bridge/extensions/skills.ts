/**
 * Skills, hooks and prompt templates for the GUI's extension pages. Ported
 * from the omp-gui fork's rpc-domains / rpc-skills / rpc-actions.
 */

import {
	deleteManagedSkill,
	MANAGED_SKILLS_PROVIDER_ID,
	sanitizeSkillName,
	writeManagedSkill,
} from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type Hook, hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { templateUsesInlineArgPlaceholders } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { optString, paramsOf, readSetting, requireString, setExtensionDisabled } from "./shared";

const MAX_SKILL_DETAIL_BYTES = 256_000;

interface SkillInfo {
	name: string;
	description: string;
	source: string;
	enabled: boolean;
	location: string;
	provider: string;
	providerName: string;
	level: string;
	managed: boolean;
	hidden: boolean;
}

/**
 * Every discoverable skill with its live enable state. The session's loaded
 * set already passed every disable channel; stock's disabled-inclusive
 * inventory keeps disabled skills visible without changing provider policy.
 */
async function listSkills(session: AgentSession): Promise<SkillInfo[]> {
	const enabledNames = new Set(session.skills.map(skill => skill.name));
	const discovered = await loadCapability<Skill>("skills", {
		cwd: session.sessionManager.getCwd(),
		agentDir: session.settings.getAgentDir(),
		extensionRoots: session.effectiveExtensionRoots,
		includeDisabled: true,
		disabledExtensions: readSetting<string[]>(session, "disabledExtensions") ?? [],
	});
	return discovered.items.map(skill => {
		return {
			name: skill.name,
			description: skill.frontmatter?.description ?? "",
			source: `${skill._source.provider}:${skill.level}`,
			enabled: enabledNames.has(skill.name),
			location: skill.path,
			provider: skill._source.provider,
			providerName: skill._source.providerName,
			level: skill._source?.level ?? "user",
			managed: skill._source?.provider === MANAGED_SKILLS_PROVIDER_ID,
			hidden: skill.frontmatter?.hide === true || skill.frontmatter?.disableModelInvocation === true,
		};
	});
}

async function findSkill(session: AgentSession, rawName: string): Promise<SkillInfo> {
	const name = rawName.trim();
	if (!name) throw new Error("Skill name cannot be empty.");
	const skill = (await listSkills(session)).find(candidate => candidate.name === name);
	if (!skill) throw new Error(`Skill "${name}" not found.`);
	return skill;
}

const hookKey = (hook: Hook) => `${hook.type}:${hook.tool}:${hook.name}`;

export const methods: BridgeMethods = guard("skills", {
	get_skills: async (_params, env) => ({ skills: await listSkills(env.session()) }),

	/** Read a discovered skill by name, so the GUI can never name an arbitrary path. */
	get_skill_detail: async (params, env) => {
		const skill = await findSkill(env.session(), requireString(paramsOf(params), "name"));
		const file = Bun.file(skill.location);
		if (file.size > MAX_SKILL_DETAIL_BYTES) {
			throw new Error(`Skill "${skill.name}" is too large to preview (${file.size} bytes).`);
		}
		const { body } = parseFrontmatter(await file.text(), { source: skill.location });
		return { ...skill, body: body.trim() };
	},

	/** `skill:<name>` in `disabledExtensions`; `refreshSkills` re-reads it live. */
	set_skill_enabled: async (params, env) => {
		const p = paramsOf(params);
		const name = requireString(p, "name");
		if (!name.trim()) throw new Error("Skill name cannot be empty");
		if (typeof p.enabled !== "boolean") throw new Error("`enabled` must be a boolean");
		const enabled = p.enabled === true;
		const session = env.session();
		const state = await setExtensionDisabled(session, `skill:${name}`, enabled);
		await session.refreshSkills();
		return { name, ...state, enabled: session.skills.some(skill => skill.name === name) };
	},

	/** Create/update/delete only omp-managed skills; authored and plugin skills stay read-only. */
	manage_skill: async (params, env) => {
		const p = paramsOf(params);
		const action = p.action;
		if (action !== "create" && action !== "update" && action !== "delete") {
			throw new Error(`Unknown manage_skill action: ${String(action)}`);
		}
		const session = env.session();
		const name = sanitizeSkillName(requireString(p, "name"));
		const description = optString(p, "description") ?? "";
		const body = optString(p, "body") ?? "";
		if (action === "create") {
			if ((await listSkills(session)).some(skill => skill.name === name)) {
				throw new Error(`Skill "${name}" already exists. Choose a different name.`);
			}
			await writeManagedSkill({ action, name, description, body });
		} else {
			const existing = await findSkill(session, name);
			if (!existing.managed) {
				throw new Error(`Skill "${name}" is managed by ${existing.providerName} and is read-only here.`);
			}
			if (action === "delete") await deleteManagedSkill(name);
			else await writeManagedSkill({ action, name, description, body });
		}
		await session.refreshSkills();
		return { action, name };
	},

	/** Enable state is the diff between a `disabledExtensions`-filtered and an unfiltered discovery. */
	get_hooks: async (_params, env) => {
		const session = env.session();
		const cwd = session.sessionManager.getCwd();
		const disabledExtensions = readSetting<string[]>(session, "disabledExtensions") ?? [];
		const [enabledResult, allResult] = await Promise.all([
			loadCapability<Hook>(hookCapability.id, { cwd, disabledExtensions: [...disabledExtensions] }),
			loadCapability<Hook>(hookCapability.id, { cwd, includeDisabled: true }),
		]);
		const enabledKeys = new Set(enabledResult.items.map(hookKey));
		const hooks = allResult.items
			.map(hook => ({
				id: hookCapability.toExtensionId?.(hook) ?? `hook:${hookKey(hook)}`,
				name: hook.name,
				event: `${hook.type}:${hook.tool}`,
				enabled: enabledKeys.has(hookKey(hook)),
				source: hook._source.provider,
				path: hook.path,
			}))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
		return { hooks };
	},

	/** Hooks bind at extension load and nothing rebinds them live: takes effect next session. */
	set_hook_enabled: async (params, env) => {
		const p = paramsOf(params);
		const id = requireString(p, "hookId");
		if (!id.startsWith("hook:")) {
			throw new Error(`Invalid hook id: ${id} (expected "hook:<type>:<tool>:<name>")`);
		}
		if (typeof p.enabled !== "boolean") throw new Error("`enabled` must be a boolean");
		const enabled = p.enabled === true;
		const state = await setExtensionDisabled(env.session(), id, enabled);
		return { id, ...state };
	},

	get_prompt_templates: async (_params, env) => ({
		templates: env.session().promptTemplates.map(template => ({
			name: template.name,
			description: template.description,
			source: template.source,
			argumentHint: templateUsesInlineArgPlaceholders(template.content) ? "[arguments]" : undefined,
		})),
	}),
});
