/** The session tree and the plan document the view sheets (Session tree, Plan) show in the dev harness. */
import type { SessionTreeEntry, SessionTreeResult } from "../components/panels/session-tree-layout";

const NOW = Date.now();

const STEPS: [role: SessionTreeEntry["role"], text: string][] = [
	["user", "Fix the flaky sidebar test"],
	["assistant", "Reproduce with --repeat 10 to see how often it fails"],
	["user", "Run it ten times and report"],
	["assistant", "Fails 3 of 10: the row is asserted before it mounts"],
	["user", "Wait for the row, then run the suite"],
	["assistant", "Waited for the row; the suite passes 10 of 10"],
	["assistant", "Branch: try a fake clock instead of waiting"],
	["user", "Does the fake clock hide paint timing?"],
	["assistant", "It does: the assertion passes before the row paints"],
];

/** Entries e0..e5 are the active branch; e6..e8 fork from e3 (the fake-clock attempt). */
const TREE: SessionTreeEntry[] = STEPS.map(([role, text], index) => ({
	entryId: `e${index}`,
	parentId: index === 0 ? null : index === 6 ? "e3" : `e${index - 1}`,
	role,
	textPreview: text,
	timestamp: NOW - (STEPS.length - index) * 60_000,
	...(index === 5 ? { label: "passing" } : {}),
	onActiveBranch: index < 6,
	isLeaf: index === 5 || index === 8,
}));

export const SESSION_TREE: SessionTreeResult = { tree: TREE, activeLeafId: "e5" };

export const PLAN_FILE_PATH = "/Users/dev/projects/ompdesk/.omp/plans/fix-flaky-sidebar.md";

export const PLAN_MARKDOWN = [
	"# Fix the flaky sidebar test",
	"",
	"## Steps",
	"",
	"1. Reproduce the flake with `--repeat 10`",
	"2. Wait for the row to mount before asserting",
	"3. Run the suite ten times",
	"",
	"## Risks",
	"",
	"- The settings page has the same race",
	"- A fake clock hides real paint timing",
	"",
	"| Step | Owner | State |",
	"| --- | --- | --- |",
	"| Reproduce | agent | done |",
	"| Fix | agent | doing |",
	"| Verify | agent | todo |",
	"",
].join("\n");
