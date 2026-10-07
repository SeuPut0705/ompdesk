/**
 * Agent definition files: read, write, delete and template installs for the
 * two directories omp discovers task agents from — the user directory
 * (`~/.omp/agent/agents`) and the nearest project `.omp/agents`. The bridge
 * reports both paths (`get_agent_authoring`, computed with omp's own
 * `getConfigDirs` / `findAllNearestProjectConfigDirs`), so ompdesk writes
 * exactly where discovery reads.
 *
 * Every path from the renderer is checked to be a direct `*.md` child of one
 * of those directories (discovery does not recurse), names go through the
 * same check the editor uses, writes are atomic (temp file + rename) and new
 * files never replace an existing one (`link` fails on an existing target).
 */

import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
	agentFileName,
	agentNameError,
	parseAgentMarkdown,
	serializeAgentMarkdown,
} from "../../shared/agent-definition";
import { AGENT_TEMPLATES, templateDraft } from "../../shared/agent-templates";
import type {
	AgentFileScope,
	RpcAgentAuthoringInfo,
	RpcAgentFileContent,
	RpcAgentTemplatesInstallResult,
} from "../../shared/rpc-types";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

export type AgentDirs = Record<AgentFileScope, string>;

const MAX_AGENT_FILE_BYTES = 512 * 1024;

function scopeOf(value: unknown): AgentFileScope {
	if (value === "user" || value === "project") return value;
	throw new LocalCommandError('`scope` must be "user" or "project".', "invalid_scope");
}

async function realDir(dir: string): Promise<string> {
	const resolved = path.resolve(dir);
	try {
		return await fsp.realpath(resolved);
	} catch {
		return resolved;
	}
}

/**
 * The checked path and the agents directory it sits directly in, or a
 * `path_outside` error. Symlinked directories (e.g. a dotfiles-managed
 * `~/.omp`) compare by their real path.
 */
export async function locateAgentFile(
	dirs: AgentDirs,
	filePath: unknown,
): Promise<{ file: string; scope: AgentFileScope }> {
	if (typeof filePath !== "string" || !path.isAbsolute(filePath) || path.extname(filePath) !== ".md") {
		throw new LocalCommandError("Not an agent definition file path.", "path_outside");
	}
	const parent = await realDir(path.dirname(filePath));
	for (const scope of ["project", "user"] as const) {
		if (parent === (await realDir(dirs[scope]))) return { file: filePath, scope };
	}
	throw new LocalCommandError("The file is outside the user and project agent directories.", "path_outside");
}

export async function readAgentFile(dirs: AgentDirs, filePath: unknown): Promise<RpcAgentFileContent> {
	const { file, scope } = await locateAgentFile(dirs, filePath);
	return { filePath: file, scope, content: await fsp.readFile(file, "utf8") };
}

/** Write `content` to `target` through a sibling temp file; `exclusive` refuses to replace an existing file. */
async function atomicWrite(target: string, content: string, exclusive: boolean): Promise<void> {
	const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
	await fsp.writeFile(tmp, content, { encoding: "utf8", mode: 0o644 });
	try {
		if (exclusive) await fsp.link(tmp, target);
		else await fsp.rename(tmp, target);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
			throw new LocalCommandError(`An agent file named ${path.basename(target)} already exists.`, "exists");
		}
		throw cause;
	} finally {
		await fsp.rm(tmp, { force: true });
	}
}

export interface WriteAgentFileParams {
	scope?: unknown;
	name?: unknown;
	content?: unknown;
	/** The file being edited; it may be replaced (or renamed away from). */
	replacePath?: unknown;
}

/**
 * Save a definition as `<dir>/<name>.md`. The content must parse to the same
 * name with a description (so discovery will accept it). Editing in place
 * overwrites; a new name or scope creates the new file first, then removes
 * the old one.
 */
export async function writeAgentFile(dirs: AgentDirs, params: WriteAgentFileParams): Promise<{ filePath: string }> {
	const scope = scopeOf(params.scope);
	if (typeof params.name !== "string") throw new LocalCommandError("`name` must be a string.", "invalid_name");
	const name = params.name.trim();
	const nameError = agentNameError(name);
	if (nameError) throw new LocalCommandError(`Invalid agent name (${nameError}).`, "invalid_name");
	if (typeof params.content !== "string")
		throw new LocalCommandError("`content` must be a string.", "invalid_content");
	const content = params.content;
	if (Buffer.byteLength(content, "utf8") > MAX_AGENT_FILE_BYTES) {
		throw new LocalCommandError("The agent file is too large.", "invalid_content");
	}
	const parsed = parseAgentMarkdown(content);
	if (parsed.error) throw new LocalCommandError(`Frontmatter is not valid YAML: ${parsed.error}`, "invalid_content");
	if (parsed.draft.name !== name) {
		throw new LocalCommandError("The frontmatter name does not match the file name.", "invalid_content");
	}
	if (!parsed.draft.description) throw new LocalCommandError("The description is required.", "invalid_content");

	const dir = path.resolve(dirs[scope]);
	const target = path.join(dir, agentFileName(name));
	if (path.dirname(target) !== dir) throw new LocalCommandError("Invalid agent name.", "invalid_name");

	const previous =
		params.replacePath === undefined || params.replacePath === null
			? undefined
			: (await locateAgentFile(dirs, params.replacePath)).file;
	await fsp.mkdir(dir, { recursive: true });

	// Editing in place (also a case-only rename on a case-insensitive volume): overwrite.
	const real = (file: string) => fsp.realpath(file).catch(() => file);
	if (previous !== undefined && (await real(previous)) === (await real(target))) {
		await atomicWrite(target, content, false);
		return { filePath: target };
	}
	await atomicWrite(target, content, true);
	if (previous !== undefined) await fsp.rm(previous, { force: true });
	return { filePath: target };
}

export async function deleteAgentFile(dirs: AgentDirs, filePath: unknown): Promise<{ deleted: string }> {
	const { file } = await locateAgentFile(dirs, filePath);
	await fsp.rm(file);
	return { deleted: file };
}

/**
 * Write the bundled templates (all, or `names`) into `dir`. Existing files are
 * never touched: a name whose file already exists is reported as skipped.
 */
export async function installAgentTemplates(
	dir: string,
	names?: readonly string[],
): Promise<RpcAgentTemplatesInstallResult> {
	const wanted = names ? AGENT_TEMPLATES.filter(template => names.includes(template.name)) : AGENT_TEMPLATES;
	const resolved = path.resolve(dir);
	await fsp.mkdir(resolved, { recursive: true });
	const installed: string[] = [];
	const skipped: string[] = [];
	for (const template of wanted) {
		const content = serializeAgentMarkdown(templateDraft(template));
		try {
			await atomicWrite(path.join(resolved, agentFileName(template.name)), content, true);
			installed.push(template.name);
		} catch (cause) {
			if (cause instanceof LocalCommandError && cause.code === "exists") skipped.push(template.name);
			else throw cause;
		}
	}
	return { dir: resolved, installed, skipped };
}

async function agentDirs(ctx: LocalCommandContext): Promise<AgentDirs> {
	const info = await ctx.bridge.request<RpcAgentAuthoringInfo>("get_agent_authoring");
	return info.dirs;
}

export const handlers: Record<string, LocalHandler> = {
	read_agent_file: async (command, ctx) => readAgentFile(await agentDirs(ctx), command.filePath),
	write_agent_file: async ({ scope, name, content, replacePath }, ctx) =>
		writeAgentFile(await agentDirs(ctx), { scope, name, content, replacePath }),
	delete_agent_file: async (command, ctx) => deleteAgentFile(await agentDirs(ctx), command.filePath),
	install_agent_templates: async (command, ctx) => {
		const dirs = await agentDirs(ctx);
		const names = Array.isArray(command.names)
			? command.names.filter((name): name is string => typeof name === "string")
			: undefined;
		return installAgentTemplates(dirs[scopeOf(command.scope)], names);
	},
};
