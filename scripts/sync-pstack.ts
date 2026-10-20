/**
 * Vendor pstack (cursor/plugins `pstack`, MIT, Lauren Tan) at the commit pinned in
 * `resources/omp-builtin/pstack/pstack-config.json` into `resources/omp-builtin/pstack/` and translate its Cursor and
 * Claude names to omp and OMPdesk ones. Run after every pin bump:
 *
 *   bun run sync:pstack            copy + translate + regenerate (needs network, or PSTACK_SRC=<clone at the pin>)
 *   bun run sync:pstack -- --check pin vs the newest upstream past the 3-day hold (scripts/skill-packs.ts check pstack)
 *
 * Owned by OMPdesk and never touched here: `pstack-config.json` (the one version pin), `adapter.md`,
 * `agents/pstack-agent.md`, `README.md`. Everything else under the pack is generated; `pstack-manifest.json` holds its
 * sha256 list, which `src/main/pstack/pack-drift.test.ts` checks, so a hand edit of a generated file fails there.
 * Every translation rule must match at least once: when upstream rewords a line a rule hung on, this script fails
 * instead of quietly shipping an untranslated Cursor name.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import config from "../resources/omp-builtin/pstack/pstack-config.json" with { type: "json" };
import { assemblePstackSections, renderTextModule } from "./pstack-section";

const ROOT = path.resolve(import.meta.dir, "..");
const PACK = path.join(ROOT, "resources/omp-builtin/pstack");
const TEXT_MODULE = path.join(ROOT, "resources/gui-bridge/modes/pstack-text.ts");
const LICENSE_COPY = path.join(ROOT, "LICENSES/MIT-pstack.txt");
const MANIFEST = path.join(PACK, "pstack-manifest.json");

/** Upstream skills the pack does not carry (Cursor-only or replaced by OMPdesk's own settings). */
const SKIPPED_SKILLS = new Set(["setup-pstack", "poteto-help", "make-bot-ui"]);
/** Files under `skills/` the pack does not carry (paths relative to `skills/`). */
const SKIPPED_PATHS: RegExp[] = [
	/^poteto-mode\/scripts\/(watch-pr|orch)\//,
	/^poteto-mode\/scripts\/(bootstrap\.ts|bun\.lock|package\.json|check-plan\.test\.ts)$/,
	/^poteto-mode\/playbooks\/orchestrate\.md$/,
	/^poteto-mode\/references\/bugbot-triage\.md$/,
];
/** Skills renamed so none collides with a stock or common user skill (`tdd`, `teach`). */
const RENAMED_SKILLS: Record<string, string> = { tdd: "pstack-tdd", teach: "pstack-teach" };
/** OMPdesk-owned files: kept as they are and never regenerated. */
const OWNED = ["pstack-config.json", "adapter.md", "agents/pstack-agent.md", "README.md"];

interface Rule {
	id: string;
	/** Matches the path relative to `skills/` (or `agents/<file>`). */
	files: RegExp;
	from: string | RegExp;
	to: string;
}

const MODEL_ROLES =
	"Model roles: `@task` for code delegates, `@slow` for judgment, prose and the hardest change, `@smol` for light research, and a judge or cross-check on a model family different from the parent's (the `advisor` role, or another configured provider).";

const ANY = /.*/;
const rule = (id: string, files: RegExp, from: string | RegExp, to: string): Rule => ({ id, files, from, to });

const RULES: Rule[] = [
	// ── poteto-mode ──────────────────────────────────────────────────────────────────────────────
	rule(
		"mode-cite",
		/^poteto-mode\/SKILL\.md$/,
		"In your reply, name each principle that shaped a decision",
		"When a playbook shaped the work, name in your reply each principle that shaped a decision",
	),
	rule(
		"mode-intro",
		/^poteto-mode\/SKILL\.md$/,
		"Bundled skills live at `../<name>/SKILL.md` from this file, so put this file's absolute path in every `poteto-agent` prompt.",
		"Bundled skills are read as `skill://<name>`. Tell every `pstack-agent` you spawn to read `skill://poteto-mode` first.",
	),
	rule("mode-askquestion", /^poteto-mode\/SKILL\.md$/, "About to `AskQuestion` on", "About to `ask` on"),
	rule(
		"mode-create-skill",
		/^poteto-mode\/SKILL\.md$/,
		"Agent-facing prose also follows the **create-skill** skill (Cursor's built-in for authoring SKILL.md files).",
		"Agent-facing prose also follows the user's skill-writing skill when one is installed (`writing-great-skills`), else the **authoring-a-skill** playbook.",
	),
	rule(
		"mode-deslop",
		/^poteto-mode\/SKILL\.md$/,
		"- Before commit → the `deslop` skill from the `cursor-team-kit` plugin (`/deslop`).",
		"- Before commit → the user's `ponytail-review` skill when it is installed, else the **unslop** skill with **principle-laziness-protocol** over the diff.",
	),
	rule(
		"mode-control",
		/^poteto-mode\/SKILL\.md$/,
		"`cursor-team-kit` publishes `control-cli` (CLIs and TUIs) and `control-ui` (browser / Electron / web UIs).",
		"Drive a CLI or TUI through `bash` (or `debug`), a browser or Electron UI through the `ego-browser` skill or the OMPdesk preview, a desktop app through `computer` when it exists.",
	),
	rule(
		"mode-babysit",
		/^poteto-mode\/SKILL\.md$/,
		", not Cursor's built-in babysit skill, whose description matches the same words",
		", not any other babysit skill whose description matches the same words",
	),
	rule(
		"mode-bugbot",
		/^poteto-mode\/SKILL\.md$/,
		/- Bugbot or the agentic security review commented → skeptical posture\..*\n/,
		"- A review bot or an automated security review commented → skeptical posture. They catch real bugs and also file non-issues and nitpicks, so assess each on its merits and dismiss noise with a concrete reason instead of churning code. Fix, dismiss or ask per comment.\n",
	),
	rule(
		"mode-loop",
		/^poteto-mode\/SKILL\.md$/,
		'"trust it when i\'m back", "/loop until X")',
		'"trust it when i\'m back", "keep looping until X")',
	),
	rule(
		"mode-subagents",
		/^poteto-mode\/SKILL\.md$/,
		/## Subagents\n[\s\S]*?(?=\n## Writing the reply)/,
		'## Subagents\n\nSubagents run through omp\'s `task` tool. Pass `agent: "pstack-agent"` for code-writing delegates and ad-hoc helpers (it reads this skill first), leave `agent` out for the default `task` agent, use `scout` or `reviewer` for read-only work. The chat that runs the playbook never delegates the playbook itself. Routed workflow skills (`how`, `why`, `interrogate`, `reflect`, `swarm`) set their own spawns, so respect what they prescribe.\n\n' +
			`${MODEL_ROLES} Hand a hard change to \`@slow\` through the task call's model override. File pointers beat inlined context. You own every subagent's work: review the diff and write your own summary. A second opinion is the same prompt on a different model, and agreement is high-signal. Give new work to a fresh subagent with the consolidated brief, every later directive and the prior report. Reuse one only when the new work strictly needs state that lives in it (its checkout, uncommitted changes, a running process). A session you opened with \`ompdesk_session_open\` is the exception: continue it with \`ompdesk_session_send\`.\n`,
	),
	rule(
		"mode-todolist",
		/^poteto-mode\/SKILL\.md$/,
		"Open a todolist whose first items are the matched playbook's steps, copied in verbatim, before any task-specific todos.",
		"Open a `todo` list whose first items are the matched playbook's steps, copied in one per step in its order, before any task-specific todos. Write each copied step in the todo language your `<reply-language>` section sets (word for word without one), keeping skill, tool and file names as written.",
	),
	rule("mode-todolist-copy", /^poteto-mode\/SKILL\.md$/, "Copy its steps in verbatim.", "Copy its steps in that way."),
	rule(
		"mode-playbooks-file",
		/^poteto-mode\/SKILL\.md$/,
		/and open its full steps at `playbooks\/<title>\.md`, with the title in kebab case, hyphens kept and other punctuation dropped, unless the entry gives its file\./,
		"and open its full steps at the `skill://poteto-mode/playbooks/<file>.md` path printed after the entry.",
	),
	rule("mode-pause-cursor", /^poteto-mode\/SKILL\.md$/, "a Cursor restart", "an omp or OMPdesk restart"),
	rule("mode-orchestrate-entry", /^poteto-mode\/SKILL\.md$/, /- \*\*Orchestrate\.\*\*.*\n/, ""),
	rule(
		"mode-orchestrate-route",
		/^poteto-mode\/SKILL\.md$/,
		/ A standing project-scale program \(multi-day[^\n]*?\. figure-it-out designs one bespoke run, orchestrate runs the program\./,
		" A standing project-scale program (multi-day, many stacked PRs) routes to **figure-it-out** too, with each unit as an OMPdesk session (`ompdesk_session_open`).",
	),
	// ── skills that spawn model-specific subagents ───────────────────────────────────────────────
	rule(
		"interrogate-spawn",
		/^interrogate\/SKILL\.md$/,
		/Launch all reviewers in a single message with the Task tool, one per entry on the[\s\S]*?(?=\nRead `references\/reviewer-prompt\.md`)/,
		`Launch all reviewers in one \`task\` call (a \`tasks[]\` batch), labeled Reviewer A, B, and so on.\n\n| Subagent | Model |\n|----------|-------|\n| Reviewer A | \`@slow\` |\n| Reviewer B | a different model family from the parent (the \`advisor\` role, or another configured provider) |\n\nEach reviewer is \`agent: "reviewer"\` (read-only) with its model set from the table. If the \`task\` tool rejects a model, run that reviewer on \`@slow\` and say so. Do not block the review on the model issue.\n`,
	),
	rule(
		"swarm-model",
		/^swarm\/SKILL\.md$/,
		/4\. Pick the worker model from the `swarm workers` line[^\n]*?For a model race, name each arm's model up front\./,
		"4. Pick the worker model: `@task` by default. If the task tool rejects a model, use `@task` and say so. For a model race, name each arm's model up front.",
	),
	rule(
		"swarm-spawn",
		/^swarm\/SKILL\.md$/,
		/Spawn all N workers in one message with `subagent_type: generalPurpose`[^\n]*\n\nWhen a worker must start from a non-default pushed branch, pass `cloud_base_branch`\./,
		"Spawn all N workers in one `task` call (a `tasks[]` batch) with the step 4 model. A worker that writes files and needs its own checkout runs as an OMPdesk session instead: `ompdesk_session_open` with `worktree: true` (at most 4 per call), compared with `ompdesk_compare`. A worker that must start from another branch gets that base in the session brief.",
	),
	// Fan-out only pays for items of minutes each (measured 20 Oct 2026, see feature-delegate-speed).
	rule(
		"swarm-size",
		/^swarm\/SKILL\.md$/,
		/## Start\n\n/,
		"## Start\n\nSwarm only items that each take minutes of work: a worker starts from nothing and takes a minute or more before its first edit, so a few small edits finish sooner as parallel tool calls in one response, even when the request asks for parallel work.\n\n",
	),
	rule(
		"mode-fanout-size",
		/^poteto-mode\/SKILL\.md$/,
		"- Parallel fan-out → the **swarm** skill",
		"- Parallel fan-out of items that each take minutes → the **swarm** skill (a few small edits go as parallel tool calls in one response instead)",
	),
	rule(
		"why-models",
		/^why\/SKILL\.md$/,
		/Each spawn below names a role line in the `pstack-models\.mdc` rule and a default\.[\s\S]*?(?=\n\nEvery spawn is `generalPurpose`)/,
		"Each spawn below names a model role: `@task` for investigators, `@slow` for the synthesizer. If the `task` tool rejects a model, use the role's default and say so.",
	),
	rule(
		"why-readonly",
		/^why\/SKILL\.md$/,
		/Every spawn is `generalPurpose` with `readonly: false` \(agent mode\)\.[^\n]*/,
		"Every spawn is the default `task` agent, because `scout` has no MCP access and the MCP-backed investigators and the synthesizer's citation spot-checks need it. Investigators still shouldn't write anything.",
	),
	rule(
		"why-discovery",
		/^why\/SKILL\.md$/,
		/list the available MCPs from the Cursor environment\. Use the available-tools map when present\. Otherwise inspect the `mcps\/` directory Cursor exposes for enabled MCP servers\./,
		"list the available MCPs: the `mcp__` tools in your tool list, and `mcp_search` when it exists.",
	),
	rule(
		"why-investigators",
		/^why\/SKILL\.md$/,
		"`model`: the `why investigators` line, default `grok-4.7-xhigh-fast`.",
		"`model`: `@task`.",
	),
	rule(
		"why-synth",
		/^why\/SKILL\.md$/,
		"`model`: the `why synthesizer` line, default `claude-opus-5-5-xhigh`.",
		"`model`: `@slow`.",
	),
	rule(
		"how-spawn",
		/^how\/SKILL\.md$/,
		/Every spawn is a Task subagent with `subagent_type: generalPurpose` and `readonly: true`\.[\s\S]*?(?= Pick each subagent's reasoning level)/,
		'Every spawn is a `task` subagent with `agent: "scout"` (read-only). Explorers run on `@task`, and every explainer on `@slow`. If the `task` tool rejects a model, use that default and say so.',
	),
	rule(
		"reflect-agents",
		/^reflect\/SKILL\.md$/,
		/One message, three `Task` calls, `subagent_type: generalPurpose`, agent mode \(`readonly: false`\)\. Reviewers need MCP access[^\n]*/,
		"One `task` call with three `tasks[]` entries, the default `task` agent (not `scout`: reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references).",
	),
	rule(
		"reflect-models",
		/^reflect\/SKILL\.md$/,
		/Each reviewer and the synthesizer name a role line in the `pstack-models\.mdc` rule and a default\.[^\n]*/,
		"Each reviewer and the synthesizer name a model role. If the `task` tool rejects a model, use the role's default and say so.",
	),
	rule(
		"reflect-table",
		/^reflect\/SKILL\.md$/,
		"| Lens | Role line | Default `model` | Prompt template |\n|---|---|---|---|\n| Judgment | `reflect judgment, divergent, synthesizer` | `claude-opus-5-5-xhigh` | `references/judgment-reviewer.md` |\n| Tooling | `reflect tooling` | `grok-4.7-xhigh-fast` | `references/tooling-reviewer.md` |\n| Divergent | `reflect judgment, divergent, synthesizer` | `claude-opus-5-5-xhigh` | `references/divergent-reviewer.md` |",
		"| Lens | `model` | Prompt template |\n|---|---|---|\n| Judgment | `@slow` | `references/judgment-reviewer.md` |\n| Tooling | `@task` | `references/tooling-reviewer.md` |\n| Divergent | `@slow` | `references/divergent-reviewer.md` |",
	),
	rule(
		"reflect-synth",
		/^reflect\/SKILL\.md$/,
		/One `Task` call, `subagent_type: generalPurpose`, `model` from the `reflect judgment, divergent, synthesizer` line \(default `claude-opus-5-5-xhigh`\), agent mode \(`readonly: false`\)\. It spot-verifies citations through MCP, and readonly strips MCPs\./,
		"One `task` call on `@slow` with the default `task` agent. It spot-verifies citations through MCP, which `scout` cannot reach.",
	),
	rule(
		"reflect-create-skill",
		/^reflect\/SKILL\.md$/,
		"hand to Cursor's built-in `create-skill` skill and run its draft / test / iterate loop.",
		"hand to the user's skill-writing skill (`writing-great-skills`) when installed, else the `manage_skill` tool, and run its draft / test / iterate loop.",
	),
	rule(
		"reflect-synth-example",
		/^reflect\/references\/synthesizer\.md$/,
		'"Bugbot flagged regex backtracking on May 2"',
		'"A review bot flagged regex backtracking on May 2"',
	),
	rule(
		"reflect-used-skill",
		/^reflect\/references\/(judgment|tooling|divergent)-reviewer\.md$/,
		/\(under `\.cursor\/skills\/`, `~\/\.cursor\/skills\/`, or `~\/\.cursor\/plugins\/`\), a `Task` prompt naming its path, or a tool call \(Shell, Grep, MCP, etc\.\)/,
		"(under `.omp/skills/`, `.agents/skills/`, `~/.omp/agent/skills/`, `~/.agents/skills/`, or as `skill://<name>`), a `task` prompt naming its path, or a tool call (`bash`, `grep`, an MCP tool, etc.)",
	),
	rule(
		"arena-runners",
		/^arena\/SKILL\.md$/,
		/3\. Pick the runners\. Use the `arena runners` line[\s\S]*?Spawn more runners when/,
		"3. Pick the runners. Default to one `@slow` and one on a different model family from the parent (the `advisor` role, or another configured provider). If the `task` tool rejects a model, run that seat on `@slow` and say so. Spawn more runners when",
	),
	rule(
		"arena-bg",
		/^arena\/SKILL\.md$/,
		"Spawn all N subagents in one message with `run_in_background: true`, each with",
		"Spawn all N subagents in one `task` call (a `tasks[]` batch), each with",
	),
	rule(
		"arena-judge",
		/^arena\/SKILL\.md$/,
		/choose one model from the `arena cross-judge pool` line in `~\/\.cursor\/rules\/pstack-models\.mdc`\. If the rule or that line is missing, choose from `claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`\. Prefer a different model family from the parent's\. Spawn one readonly judge subagent on that model\./,
		'choose a judge model from a different family than the parent\'s (the `advisor` role, or another configured provider). Spawn one read-only judge (`agent: "reviewer"`) on that model.',
	),
	rule(
		"architect-runners",
		/^architect\/SKILL\.md$/,
		/Take the runners from the `architect runners` line in the `pstack-models\.mdc` rule, in place of the `arena runners` line\. If the rule or that line is missing, use `claude-opus-5-5-xhigh` and `grok-4\.7-xhigh-fast`\. /,
		"Take the runners as the **arena** skill's Phase A says. ",
	),
	rule(
		"no-comments-spawn",
		/^no-comments\/SKILL\.md$/,
		'Spawn `Task` with `subagent_type: "comment-sicko"`.',
		'Spawn a `task` with `agent: "comment-sicko"`.',
	),
	// ── playbooks: model slugs and delegation ────────────────────────────────────────────────────
	rule(
		"playbook-model",
		/^poteto-mode\/playbooks\/(bug-fix|feature|perf-issue|hillclimb|refactoring)\.md$/,
		/ using your configured [a-z-]+ model \(default `grok-4\.7-xhigh-fast`\)/,
		" on `@task` (`@slow` for the hardest change)",
	),
	rule(
		"playbook-tdd",
		/^poteto-mode\/playbooks\/bug-fix\.md$/,
		"See the **tdd** skill",
		"See the **pstack-tdd** skill",
	),
	rule(
		"multi-explore",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		'Explore in subagents with `subagent_type: "poteto-agent"` and an explicit model per the Subagents section',
		'Explore in subagents with `agent: "pstack-agent"` and an explicit model role per the Subagents section',
	),
	rule(
		"multi-loop",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"arm the audit tick as `/loop 1h` with the tick prompt below",
		"arm the audit tick as a recurring check (`/loop 1h` in the omp TUI, or an OMPdesk schedule via `ompdesk_schedule`) with the tick prompt below",
	),
	rule(
		"multi-lanes",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"Each live lane runs on its own cloud VM at the PR head. Drive through `control-ui` or `control-cli` from `cursor-team-kit`.",
		"Each live lane runs in its own OMPdesk session on a worktree at the PR head (`ompdesk_session_open` with `worktree: true`). Drive a browser or Electron UI through the `ego-browser` skill or the OMPdesk preview, a CLI through `bash`.",
	),
	rule(
		"multi-control",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"Browser, Electron, and web UIs use `control-ui` from `cursor-team-kit`. CLIs and TUIs use `control-cli` from `cursor-team-kit`.",
		"Browser, Electron, and web UIs use the `ego-browser` skill or the OMPdesk preview. CLIs and TUIs use `bash` or `debug`.",
	),
	rule(
		"multi-bugbot",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"- [ ] Triage every Bugbot and security-reviewer comment per `../references/bugbot-triage.md`.",
		"- [ ] Triage every review-bot and security-reviewer comment on its merits (fix with a red-first proof, or dismiss with a concrete reason).",
	),
	rule(
		"multi-bugbot-done",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"- [ ] Bugbot triage done.",
		"- [ ] Review-bot triage done.",
	),
	rule(
		"auto-wake",
		/^poteto-mode\/playbooks\/autonomous-run\.md$/,
		/Pick the wake mechanism using Cursor's `\/loop` command \(a built-in, not a pstack skill\)\. An event to watch \(CI, a merge, a ref advancing\) gets a watcher subagent that wakes you on the event, with a long time-based heartbeat as fallback\. No event gets a fixed-interval heartbeat sized to when the result is worth re-checking\./,
		"Pick the wake mechanism. OMPdesk's Goal mode or Autopilot already wakes the session, so do not build another loop. An event to watch (CI, a merge, a ref advancing) is a `wait` on a background job or `gh_run_watch`, with a long time-based heartbeat as fallback. No event gets a fixed-interval heartbeat sized to when the result is worth re-checking (`/loop` in the omp TUI).",
	),
	rule("auto-ask", /^poteto-mode\/playbooks\/autonomous-run\.md$/, "`AskQuestion`", "`ask`"),
	// Delegation for speed only when it is faster (measured 20 Oct 2026: three small independent edits fanned out to
	// three subagents took 96–152 s on GPT-6.1 against 39–52 s solo on Claude Code and Codex). The review separation
	// the playbook wants stays: a small item's own author reviews its diff fresh before verifying.
	rule(
		"feature-delegate-speed",
		/^poteto-mode\/playbooks\/feature\.md$/,
		"Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved).",
		"Delegate whenever an item takes minutes of writing; Laziness Protocol does not override that (the gain is review separation, not lines saved). An item you finish in a response or two (a few edits, a test, a help line) is faster written by you, several of them as parallel tool calls in one response: then reread your own diff against the source, as you would review a delegate's, before you verify.",
	),
	rule(
		"visual-loop",
		/^poteto-mode\/playbooks\/visual-parity\.md$/,
		"`/loop` per component until the diff is zero.",
		"Repeat per component until the diff is zero.",
	),
	rule(
		"pr-worktree",
		/^poteto-mode\/playbooks\/opening-a-pr\.md$/,
		"Multiple `Task` calls on the same branch",
		"Multiple `task` calls on the same branch",
	),
	rule(
		"pr-deslop",
		/^poteto-mode\/playbooks\/opening-a-pr\.md$/,
		"Run `/deslop` from `cursor-team-kit` over the diff before commit",
		"Run the user's `ponytail-review` skill when it is installed (else `/unslop` with **principle-laziness-protocol**) over the diff before commit",
	),
	rule(
		"autofull-deslop",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"(the `deslop` skill from the `cursor-team-kit` plugin (`/deslop`))",
		"(the user's `ponytail-review` skill when installed, else the **unslop** skill)",
	),
	rule(
		"autofull-loop",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"arm `/loop 1h` to audit",
		"arm a recurring audit (`/loop 1h` in the omp TUI, or an OMPdesk schedule) to audit",
	),
	// ── PR playbooks: Bugbot, watch-pr, Origin ───────────────────────────────────────────────────
	rule(
		"babysit-replaces",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		"This playbook replaces Cursor's built-in babysit skill for these requests, so do not route there even though i",
		"This playbook owns these requests, so do not route to any other babysit skill even though i",
	),
	rule(
		"babysit-watch",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		/On GitHub, status comes from `scripts\/watch-pr\/watch-pr`\. Run it directly\. It emits JSON by default and accepts `--pretty` for humans\. In `check` mode pass `--status-only`\. The bare command polls until a terminal verdict, which is `drive` behavior\./,
		"On GitHub, status comes from `gh pr view <pr> --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`, `gh pr checks <pr>` (add `--watch` for `drive`), and the review threads via `gh api`. In `check` mode read once and stop. Watching until a terminal verdict is `drive` behavior.",
	),
	rule(
		"babysit-public-watcher",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		/ The public watcher remains GitHub-specific, so do not pretend it covers Origin or add an Origin implementation just to run this playbook\./,
		"",
	),
	rule(
		"babysit-bugbot",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		/8\. \*\*Bugbot is triaged skeptically, always\.\*\* Verify each claim against the code per `\.\.\/references\/bugbot-triage\.md`\./,
		"8. **Review bots are triaged skeptically, always.** Verify each claim against the code before acting: a bot's finding is a hypothesis, and unused-export or stack-local usage claims are often wrong when a later PR in the stack uses the code.",
	),
	rule(
		"ship-watch",
		/^poteto-mode\/playbooks\/shipping\.md$/,
		/On GitHub, watch the run with the queued watcher from `playbooks\/babysit\.md` \(`scripts\/watch-pr\/watch-pr --queued-stack --stack-prs <bottom-to-top>`\) under `\/loop` until it reports `COMPLETE` at the ceiling\./,
		"On GitHub, watch the run with `gh pr view <pr> --json state,mergeStateStatus` for each PR, bottom to top, re-reading after every `gh pr checks <pr> --watch` return, until the ceiling reads merged.",
	),
	rule(
		"cleanup-audit",
		/^poteto-mode\/playbooks\/worktree-cleanup\.md$/,
		"run `scripts/worktree-audit.sh",
		"run `skill://poteto-mode/scripts/worktree-audit.sh",
	),
	rule(
		"plan-check",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"Run `node pstack/skills/poteto-mode/scripts/check-plan.mjs <plan.md>`",
		"Run `node <path of skill://poteto-mode>/scripts/check-plan.mjs <plan.md>`",
	),
	// ── transcripts ──────────────────────────────────────────────────────────────────────────────
	rule(
		"transcript-dir",
		ANY,
		/the `agent-transcripts\/` directory the system prompt names/g,
		"the omp session folder `~/.omp/agent/sessions/<cwd-slug>/` (the current session's `.jsonl`)",
	),
	rule(
		"transcript-active",
		ANY,
		/under the active workspace's `agent-transcripts\/` directory \((?:the system prompt names (?:the|this) path)\)/g,
		"under the active workspace's folder in `~/.omp/agent/sessions/` (`<timestamp>_<id>.jsonl`, or `ompdesk_session_read`)",
	),
	rule(
		"transcript-glob",
		ANY,
		/Do not glob across `~\/\.cursor\/projects\/\*\/`\./g,
		"Do not glob across other workspaces' folders under `~/.omp/agent/sessions/`.",
	),
	rule(
		"transcript-glob2",
		ANY,
		/Don't glob across `~\/\.cursor\/projects\/\*\/`\./g,
		"Don't glob across other workspaces' folders under `~/.omp/agent/sessions/`.",
	),
	rule(
		"transcript-recall",
		/^recall\/SKILL\.md$/,
		/Transcripts live at `~\/\.cursor\/projects\/<slug>\/agent-transcripts\/<uuid>\/<uuid>\.jsonl`, where `<slug>` is the workspace path with the leading slash dropped and each "\/" turned into "-" \(so `\/Users\/you\/proj` becomes `Users-you-proj`\)\. Every line is one chat message\./,
		"Transcripts live at `~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`, where `<cwd-slug>` is the workspace path encoded as a folder name (list `~/.omp/agent/sessions/` to see them). Every line is one JSON entry of the session (messages, tool calls, custom entries). In OMPdesk, `ompdesk_sessions` and `ompdesk_session_read` read them without touching files.",
	),
	// ── skills authoring and discovery paths ─────────────────────────────────────────────────────
	rule(
		"authoring-create-skill",
		/^poteto-mode\/playbooks\/authoring-a-skill\.md$/,
		"1. Use the **create-skill** skill (Cursor's built-in for authoring SKILL.md files).",
		"1. Use the user's skill-writing skill (`writing-great-skills`) when it is installed, else the `manage_skill` tool.",
	),
	rule(
		"automate-create-skill",
		/^automate-me\/SKILL\.md$/,
		"Cursor's built-in `create-skill` (authoring)",
		"the user's skill-writing skill (`writing-great-skills`, else `manage_skill`) for authoring",
	),
	rule(
		"automate-create-skill2",
		/^automate-me\/SKILL\.md$/,
		"Use Cursor's built-in `create-skill` skill to author the skill.",
		"Use the user's skill-writing skill (`writing-great-skills`, else the `manage_skill` tool) to author the skill.",
	),
	rule(
		"automate-find",
		/^automate-me\/SKILL\.md$/,
		/Look recursively for `\.cursor\/skills\/\*\*\/\*-mode\/SKILL\.md` and `~\/\.cursor\/skills\/\*-mode\/SKILL\.md`/,
		"Look recursively for `.omp/skills/**/*-mode/SKILL.md`, `.agents/skills/**/*-mode/SKILL.md`, `~/.omp/agent/skills/*-mode/SKILL.md` and `~/.agents/skills/*-mode/SKILL.md`",
	),
	rule(
		"automate-category",
		/^automate-me\/SKILL\.md$/,
		/\(`\.cursor\/skills\/<handle>\/`\)/,
		"(`.agents/skills/<handle>/`)",
	),
	rule(
		"automate-path",
		/^automate-me\/SKILL\.md$/,
		/`\.cursor\/skills\/<handle>\/<handle>-mode\/SKILL\.md`/g,
		"`.agents/skills/<handle>/<handle>-mode/SKILL.md`",
	),
	rule("verify-path", /^(create|maintain)-verification-skill\/SKILL\.md$/, /`\.cursor\/skills\//g, "`.agents/skills/"),
	rule(
		"bugfix-loop",
		/^poteto-mode\/playbooks\/bug-fix\.md$/,
		"Drive a long or stubborn hunt with Cursor's `/loop` command.",
		"Drive a long or stubborn hunt with a repeating check (Goal mode keeps the session going; `/loop` exists in the omp TUI).",
	),
	rule(
		"control-such-as",
		ANY,
		/\(such as `control-ui` or `control-cli` from `cursor-team-kit`\)/g,
		"(the `ego-browser` skill or the OMPdesk preview for a UI, `bash` or `debug` for a CLI)",
	),
	rule(
		"ship-verifier",
		/^poteto-mode\/playbooks\/shipping\.md$/,
		"each a Cursor cloud agent,",
		"each a `task` subagent (or an OMPdesk worktree session),",
	),
	rule(
		"multi-swarm-model",
		/^poteto-mode\/playbooks\/multi-phase-plan\.md$/,
		"on the `swarm workers` model (default `grok-4.7-xhigh-fast`)",
		"on `@task`",
	),
	rule(
		"pickup-trail",
		/^poteto-mode\/playbooks\/session-pickup\.md$/,
		/under the active workspace's `agent-transcripts\/` directory \(the system prompt names the path\. Do not glob across `~\/\.cursor\/projects\/\*\/`, that crosses workspace boundaries and reads private chats from unrelated projects\), a cloud-agent URL/,
		"under the active workspace's folder in `~/.omp/agent/sessions/` (or `ompdesk_session_read`; do not glob across other workspaces' folders, that crosses workspace boundaries and reads private chats from unrelated projects), a hosted agent's URL",
	),
	rule(
		"cleanup-wt",
		/^poteto-mode\/playbooks\/worktree-cleanup\.md$/,
		"`.cursor/worktrees/myrepo/x`",
		"`~/.omp/wt/gui-myrepo-1a2b3c4`",
	),
	rule(
		"cleanup-support",
		/^poteto-mode\/playbooks\/worktree-cleanup\.md$/,
		/`~\/Library\/Application Support\/Cursor` \(`state\.vscdb\.backup`, and `snapshots\/roots\/<root>` where a `<root>` named for a folder you opened as a workspace balloons\), /,
		"`~/.omp/agent/sessions` (old session logs, only the ones the user agrees to drop), ",
	),
	rule(
		"autofull-owner",
		/^poteto-mode\/playbooks\/autopilot-full\.md$/,
		"Each owner is a Cursor cloud agent that builds,",
		"Each owner is an OMPdesk worktree session (`ompdesk_session_open` with `worktree: true`) that builds,",
	),
	rule(
		"babysit-rubric",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		" as a candidate entry in the shared rubric (`../references/bugbot-triage.md`) and its own PR",
		" to the user as a candidate for the project's review rules",
	),
	rule(
		"babysit-loop",
		/^poteto-mode\/playbooks\/babysit\.md$/,
		/Run `drive` and `background` under `\/loop` in dynamic mode\. Rearm the watcher after every push wave and every verdict you act on\. Watcher output drives wakeups\./,
		"Run `drive` and `background` as a loop of `gh pr checks <pr> --watch` waits (Goal mode keeps the session going). Re-run the check after every push wave and every verdict you act on. Check output drives wakeups.",
	),
	rule("bugbot-lower", ANY, /the bugbot comments/g, "the review-bot comments"),
	rule(
		"mode-loop-until",
		/^poteto-mode\/SKILL\.md$/,
		'("run until done", "/loop until X")',
		'("run until done", "keep going until X")',
	),
	rule("mode-cloud-url", /^poteto-mode\/SKILL\.md$/, "cloud-agent URL", "hosted-agent URL"),
	rule(
		"automate-transcripts",
		/^automate-me\/SKILL\.md$/,
		"The system prompt names the workspace's `agent-transcripts/` directory. Use only that path.",
		"Use only this workspace's folder in `~/.omp/agent/sessions/`.",
	),
	rule("automate-cursor-dir", /^automate-me\/SKILL\.md$/, /\.cursor\/skills\//g, ".agents/skills/"),
	rule(
		"reflect-ls",
		/^reflect\/SKILL\.md$/,
		"ls -t <agent-transcripts>/*.jsonl <agent-transcripts>/*/*.jsonl <agent-transcripts>/*/subagents/*.jsonl 2>/dev/null | head -10",
		"ls -t ~/.omp/agent/sessions/<cwd-slug>/*.jsonl 2>/dev/null | head -10",
	),
	rule("reflect-task-body", /^reflect\/SKILL\.md$/, "in the `Task` response body", "in the `task` result"),
	rule(
		"audit-transcripts",
		/^poteto-mode\/scripts\/worktree-audit\.sh$/,
		"# Transcripts dir: ~/.cursor/projects/<slugified-repo-path>/agent-transcripts.\nslug=$(printf '%s' \"$main_wt\" | sed 's#^/##; s#/#-#g')\ntranscripts=\"$HOME/.cursor/projects/$slug/agent-transcripts\"",
		'# Transcripts dir: every omp session folder (the worktree path is searched for inside them).\ntranscripts="$HOME/.omp/agent/sessions"',
	),
	// ── generic ──────────────────────────────────────────────────────────────────────────────────
	rule(
		"pick-level",
		ANY,
		/ Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section( of the \*\*poteto-mode\*\* skill)?\./g,
		" Pick each subagent's model role per the Subagents section$1.",
	),
	rule("askquestion", ANY, /`AskQuestion`/g, "`ask`"),
	rule("todolist", ANY, /todolist/g, "`todo` list"),
	rule("bugbot-generic", ANY, /\bBugbot\b/g, "review-bot"),
];

interface Counted {
	rule: Rule;
	hits: number;
}

function applyRules(relPath: string, text: string, counted: Counted[]): string {
	let out = text;
	for (const entry of counted) {
		if (!entry.rule.files.test(relPath)) continue;
		const before = out;
		out =
			typeof entry.rule.from === "string"
				? out.split(entry.rule.from).join(entry.rule.to)
				: out.replace(entry.rule.from, entry.rule.to);
		if (out !== before) entry.hits++;
	}
	return out;
}

function sha256(buffer: Buffer | string): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function walk(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, base));
		else out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out.sort();
}

function upstreamSource(): { dir: string; cleanup: () => void } {
	const override = process.env.PSTACK_SRC;
	if (override) {
		const head = execFileSync("git", ["-C", override, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		if (head !== config.commit) throw new Error(`PSTACK_SRC is at ${head}, the pin is ${config.commit}`);
		return { dir: override, cleanup: () => {} };
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-src-"));
	execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${config.repo}`, tmp], {
		stdio: "inherit",
	});
	execFileSync("git", ["-C", tmp, "checkout", config.commit], { stdio: "inherit" });
	return { dir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function main(): void {
	if (process.argv.includes("--check")) {
		execFileSync("bun", [path.join(import.meta.dir, "skill-packs.ts"), "check", "pstack"], { stdio: "inherit" });
		return;
	}
	const source = upstreamSource();
	try {
		const upstream = path.join(source.dir, config.path);
		const counted: Counted[] = RULES.map(rule => ({ rule, hits: 0 }));

		// Skills.
		const skillsOut = path.join(PACK, "skills");
		fs.rmSync(skillsOut, { recursive: true, force: true });
		const upstreamSkills = path.join(upstream, "skills");
		for (const rel of walk(upstreamSkills)) {
			const [skill] = rel.split("/");
			if (SKIPPED_SKILLS.has(skill) || SKIPPED_PATHS.some(pattern => pattern.test(rel))) continue;
			const renamed = RENAMED_SKILLS[skill];
			const destRel = renamed ? `${renamed}${rel.slice(skill.length)}` : rel;
			const dest = path.join(skillsOut, destRel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			const buffer = fs.readFileSync(path.join(upstreamSkills, rel));
			if (!rel.endsWith(".md") && rel !== "poteto-mode/scripts/worktree-audit.sh") {
				fs.writeFileSync(dest, buffer);
				fs.chmodSync(dest, fs.statSync(path.join(upstreamSkills, rel)).mode & 0o777);
				continue;
			}
			let text = applyRules(rel, buffer.toString("utf8"), counted);
			if (renamed && destRel.endsWith("/SKILL.md")) {
				text = text.replace(new RegExp(`^name: ${skill}$`, "m"), `name: ${renamed}`);
			}
			if (destRel.endsWith("/SKILL.md")) text = insertNote(text);
			else if (/^poteto-mode\/playbooks\/(?!opening-a-pr)[a-z-]+\.md$/.test(destRel))
				text = insertPlaybookNote(text);
			fs.writeFileSync(dest, text);
			fs.chmodSync(dest, fs.statSync(path.join(upstreamSkills, rel)).mode & 0o777);
		}

		// Agents: the wrapper is OMPdesk's own (pstack-agent.md); comment-sicko is translated.
		const agentsOut = path.join(PACK, "agents");
		fs.mkdirSync(agentsOut, { recursive: true });
		const sicko = applyRules(
			"comment-sicko.md",
			fs.readFileSync(path.join(upstream, "agents/comment-sicko.md"), "utf8"),
			counted,
		);
		fs.writeFileSync(path.join(agentsOut, "comment-sicko.md"), withAgentTools(sicko));

		// pstack-adapter skill: the adapter text as a readable skill (subagents have no `<pstack>` section).
		const adapter = fs.readFileSync(path.join(PACK, "adapter.md"), "utf8");
		const adapterDir = path.join(skillsOut, "pstack-adapter");
		fs.mkdirSync(adapterDir, { recursive: true });
		fs.writeFileSync(
			path.join(adapterDir, "SKILL.md"),
			`---\nname: pstack-adapter\ndescription: How the pstack playbooks' tool, agent and model names map to omp and OMPdesk. Read by subagents that have no pstack section in their prompt.\ndisable-model-invocation: true\n---\n\n${adapter}`,
		);

		// License.
		const license = fs.readFileSync(path.join(upstream, "LICENSE"));
		fs.writeFileSync(path.join(PACK, "UPSTREAM-LICENSE"), license);
		fs.mkdirSync(path.dirname(LICENSE_COPY), { recursive: true });
		fs.writeFileSync(LICENSE_COPY, license);

		const unmatched = counted.filter(entry => entry.hits === 0).map(entry => entry.rule.id);
		if (unmatched.length)
			throw new Error(`pstack translation rules matched nothing (upstream reworded?): ${unmatched.join(", ")}`);

		// Generated bridge text.
		fs.writeFileSync(TEXT_MODULE, renderTextModule(assemblePstackSections(PACK)));

		// Manifest of every pack file (OMPdesk-owned ones included).
		const files = walk(PACK).filter(rel => rel !== "pstack-manifest.json");
		const manifest = Object.fromEntries(files.map(rel => [rel, sha256(fs.readFileSync(path.join(PACK, rel)))]));
		fs.writeFileSync(
			MANIFEST,
			`${JSON.stringify({ commit: config.commit, version: config.version, files: manifest }, null, "\t")}\n`,
		);
		console.log(
			`Vendored pstack ${config.version} (${config.commit.slice(0, 7)}): ${files.length} files, ${RULES.length} rules; owned: ${OWNED.join(", ")}`,
		);
	} finally {
		source.cleanup();
	}
}

/** One line under the H1 of every skill (under the frontmatter when it has none): where the adapter lives. */
function insertNote(text: string): string {
	const note =
		"> OMPdesk built-in pack. Tool, agent and model names here are the omp and OMPdesk ones; the adapter is in the `<pstack>` section of your prompt, or `skill://pstack-adapter`.";
	const match = /^# .+\n/m.exec(text) ?? /^---\n[\s\S]*?\n---\n/.exec(text);
	if (!match) throw new Error("a pack skill has no H1 heading or frontmatter");
	const at = match.index + match[0].length;
	return `${text.slice(0, at)}\n${note}\n${text.slice(at)}`;
}

/** Under the title of a playbook: the `todo` instruction, where the model is looking when it has just read the steps. */
function insertPlaybookNote(text: string): string {
	const note =
		'> OMPdesk: before step 1, call `todo` with `op: "init"` and the numbered steps below copied in as its first items, one per step in order, each written in the todo language your `<reply-language>` section sets (word for word without one; skill, tool and file names stay as written; a step you skip stays with `skip: <reason>`), then work the list.';
	const newline = text.indexOf("\n");
	if (!text.startsWith("### ") || newline < 0) throw new Error("a playbook does not start with its ### title");
	return `${text.slice(0, newline + 1)}\n${note}\n${text.slice(newline + 1)}`;
}

/** comment-sicko only reads: restrict its tools (omp agent frontmatter) and give it model roles. */
function withAgentTools(text: string): string {
	return text.replace(
		/^---\n([\s\S]*?)\n---\n/,
		(_all, head: string) => `---\n${head}\ntools: [read, grep, glob, find]\nmodel: ["@slow", "@task"]\n---\n`,
	);
}

main();
