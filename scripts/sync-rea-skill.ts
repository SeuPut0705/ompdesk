/**
 * Vendor REA's bundled `reverse-engineer-anything` skill for the pinned REA
 * version (`resources/omp-builtin/rea-config.json`) into
 * `resources/omp-builtin/skills/`. Stock discovers an extension root's
 * `skills/`, so the skill loads exactly when the built-in REA root does.
 * Run after every REA version bump:
 *
 *   bun run sync:rea-skill
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import config from "../resources/omp-builtin/rea-config.json" with { type: "json" };

const SKILL = "reverse-engineer-anything";
const DEST = path.resolve(import.meta.dir, "../resources/omp-builtin/skills", SKILL);
/** Upstream heading the OMPdesk section is inserted before, ahead of its setup guidance. */
const ANCHOR = "\n## Connect only when needed\n";

function ompdeskSection(): string {
	return `## OMPdesk built-in

OMPdesk ships REA ${config.version} built in: it starts the pinned server for each new
session and loads this skill only alongside it. The registration is current;
skip \`rea doctor\`, \`rea setup\`, \`rea update\` and \`rea uninstall\`, and never edit
agent MCP configuration or install this skill elsewhere. Users turn REA on or
off in OMPdesk Settings › Tools › MCP servers.

${config.curatedTools.length} entry tools are mounted directly as \`mcp__rea_<tool>\`. Reach every other
tool this skill names through \`rea_catalog\` (search by keyword; pass \`name\` for
its input schema) and \`rea_call\` (exact tool name and its original arguments).
If REA tools are absent or the server failed to start, report OMPdesk's
Settings › Tools › MCP servers status (Node.js and npx requirements) instead of
following the connection steps below.
`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rea-skill-"));
try {
	const tarball = execFileSync(
		"npm",
		["pack", `rea-agents@${config.version}`, "--silent", "--pack-destination", tmp],
		{ encoding: "utf8", shell: process.platform === "win32" },
	).trim();
	execFileSync("tar", ["xzf", path.join(tmp, tarball), "-C", tmp, "package/LICENSE", `package/skills/${SKILL}`]);
	const source = path.join(tmp, "package/skills", SKILL);
	const skillFile = path.join(source, "SKILL.md");
	const skill = fs.readFileSync(skillFile, "utf8");
	if (!skill.includes(ANCHOR)) throw new Error(`rea-agents@${config.version} SKILL.md lost "${ANCHOR.trim()}"`);
	fs.writeFileSync(skillFile, skill.replace(ANCHOR, `\n${ompdeskSection()}${ANCHOR}`));
	// MIT: the copyright and permission notice travel with the copied files.
	fs.copyFileSync(path.join(tmp, "package/LICENSE"), path.join(source, "LICENSE"));
	fs.rmSync(DEST, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(DEST), { recursive: true });
	fs.cpSync(source, DEST, { recursive: true });
	console.log(`Vendored ${SKILL} from rea-agents@${config.version} into ${path.relative(process.cwd(), DEST)}`);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
