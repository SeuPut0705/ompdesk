import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface RealOmpProfile {
	profile: string;
	project: string;
	desktop: string;
	agent: string;
	env: Record<string, string>;
	/** The user's `smol` role (`provider/id`), the model audits run on. */
	smol: string;
}

/**
 * A private, disposable omp agent dir for opt-in model audits: the user's
 * config.yml and credentials database are copied (never touched) into a 0700
 * directory. The main model is the user's `smol` role, so audits spend the
 * small model's tokens; subagents follow the prompt's own model hint.
 * `keepDefaultRole` leaves the user's `default` role as configured (for an audit
 * of a feature that reads it); the audit then switches its session to `smol`
 * itself (stock `set_model`, which does not persist), so the turns stay cheap.
 */
export async function realOmpProfile(
	prefs: Record<string, unknown> = {},
	options: { keepDefaultRole?: boolean } = {},
): Promise<RealOmpProfile> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-real-"));
	await fs.chmod(profile, 0o700);
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent, { mode: 0o700 })]);
	const config = await fs.readFile(path.join(os.homedir(), ".omp/agent/config.yml"), "utf8");
	const smol = /^ {2}smol:\s*(\S+)\s*$/m.exec(config)?.[1];
	if (!smol) throw new Error("config.yml has no modelRoles.smol to run the audit on");
	await fs.writeFile(
		path.join(agent, "config.yml"),
		options.keepDefaultRole ? config : config.replace(/^ {2}default:\s*\S+\s*$/m, `  default: ${smol}`),
	);
	execFileSync("sqlite3", [
		path.join(os.homedir(), ".omp/agent/agent.db"),
		`VACUUM INTO '${path.join(agent, "agent.db").replaceAll("'", "''")}'`,
	]);
	execFileSync("git", ["init", "--quiet"], { cwd: project });
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
			...prefs,
		}),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	Reflect.deleteProperty(env, "OMP_GUI_OMP");
	return { profile, project, desktop, agent, env, smol };
}
