/** `?card=pass|fail|cmd|one|live` on the harness appends a work card. pass/fail: finished, files, a type check (failing for `fail`), tests, a dev server, a screenshot, two agents. cmd: the checks pass but a push fails. one: a single command. live: the same run still going, its tests running. */
const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="720" height="320" viewBox="0 0 720 320"><rect width="720" height="320" fill="#faf9f6"/><rect width="720" height="38" fill="#eceae5"/><text x="48" y="94" font-family="sans-serif" font-size="28" fill="#35332e">Project overview</text><rect x="48" y="158" width="288" height="110" rx="8" fill="#efede7"/><rect x="358" y="158" width="314" height="110" rx="8" fill="#efede7"/></svg>';

export type CardVariant = "pass" | "fail" | "cmd" | "one" | "live";
export const CARD_LIVE_CALL = "card-tests";

export function cardTurnMessages(base: number, variant: CardVariant): Record<string, unknown>[] {
	const fail = variant === "fail";
	let at = base;
	const tick = () => {
		at += 3_000;
		return at;
	};
	const step = (
		id: string,
		name: string,
		args: Record<string, unknown>,
		result: { content: unknown[]; details?: Record<string, unknown>; isError?: boolean },
		intent?: string,
	): Record<string, unknown>[] => [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args, ...(intent ? { intent } : {}) }],
			stopReason: "toolUse",
			timestamp: tick(),
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			...result,
			isError: result.isError ?? false,
			timestamp: tick(),
		},
	];
	const diff = [
		"@@ -1,4 +1,38 @@",
		" export const workspace = {",
		"-  ready: true,",
		...Array.from({ length: 35 }, (_, i) => `+  check${i + 1}: true,`),
		" };",
	].join("\n");
	if (variant === "one") {
		return [
			{ role: "user", content: "Add the workspace state and check it.", timestamp: base },
			...step(
				"card-status",
				"bash",
				{ command: "git status --short", intent: "Checking what changed" },
				{ content: [{ type: "text", text: " M src/workspace.ts" }], details: { exitCode: 0 } },
				"Checking what changed",
			),
			{
				role: "assistant",
				content: [{ type: "text", text: "Done. One file is modified." }],
				stopReason: "stop",
				timestamp: tick(),
			},
		];
	}
	return [
		{ role: "user", content: "Add the workspace state and check it.", timestamp: base },
		...step(
			"card-types",
			"bash",
			{ command: "bun run check:types", intent: "Checking the workspace types" },
			fail
				? {
						content: [
							{
								type: "text",
								text: "$ tsc --noEmit\nsrc/workspace.ts(3,3): error TS2322: Type 'string' is not assignable to type 'boolean'.\nerror: script \"check:types\" exited with code 2",
							},
						],
						details: { exitCode: 2 },
					}
				: {
						content: [{ type: "text", text: "$ tsc --noEmit\nChecking renderer components…" }],
						details: { exitCode: 0 },
					},
			"Checking the workspace types",
		),
		...step(
			"card-write",
			"write",
			{
				path: "src/workspace.ts",
				content: "export const workspace = {\n  title: 'Live work',\n  ready: true,\n};\n",
			},
			{ content: [{ type: "text", text: "Wrote src/workspace.ts" }] },
		),
		...step(
			"card-edit",
			"edit",
			{ path: "src/workspace.ts", edits: [{ old_text: "  ready: true,", new_text: "  ready: false," }] },
			{ content: [{ type: "text", text: "Updated workspace state" }], details: { diff } },
		),
		...step(
			"card-task",
			"task",
			{
				tasks: [
					{ name: "WorkspaceScout", task: "Read the workspace state" },
					{ name: "WorkspaceReview", task: "Review accessibility" },
				],
			},
			{
				content: [{ type: "text", text: "Agents finished" }],
				details: {
					results: [
						{ id: "WorkspaceScout", agent: "explore", output: "Workspace has 5 lines.", exitCode: 0 },
						{ id: "WorkspaceReview", agent: "explore", output: "Workspace has 5 lines.", exitCode: 0 },
					],
				},
			},
		),
		...step(
			"card-shot",
			"browser",
			{ action: "run", code: "await tab.screenshot()", url: "https://example.com/workspace" },
			{
				content: [{ type: "image", mimeType: "image/svg+xml", data: btoa(SVG) }],
				details: { url: "https://example.com/workspace" },
			},
		),
		...(variant === "live"
			? [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: CARD_LIVE_CALL,
								name: "bash",
								arguments: { command: "bunx vitest run", intent: "Running the workspace tests" },
								intent: "Running the workspace tests",
							},
						],
						stopReason: "toolUse",
						timestamp: tick(),
					},
				]
			: [
					...step(
						"card-tests",
						"bash",
						{ command: "bunx vitest run", intent: "Running the workspace tests" },
						{
							content: [
								{
									type: "text",
									text: " Test Files  4 passed (4)\n      Tests  128 passed (128)\n   Duration  2.31s",
								},
							],
							details: { exitCode: 0 },
						},
						"Running the workspace tests",
					),
					...step(
						"card-dev",
						"bash",
						{ command: "bun run dev", intent: "Starting the dev server" },
						{
							content: [
								{
									type: "text",
									text: "$ vite\n\n  VITE v7.1.2  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/",
								},
							],
							details: { exitCode: 0 },
						},
						"Starting the dev server",
					),
				]),
		...(variant === "cmd"
			? step(
					"card-push",
					"bash",
					{ command: "git push origin main", intent: "Publishing the branch" },
					{
						content: [
							{
								type: "text",
								text: "remote: Permission to ompdesk/ompdesk.git denied to bot.\nfatal: unable to access 'https://github.com/ompdesk/ompdesk.git/': The requested URL returned error: 403\nCommand exited with code 128",
							},
						],
						details: { exitCode: 128 },
						isError: true,
					},
					"Publishing the branch",
				)
			: []),
		...(variant === "live"
			? []
			: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Done. The workspace state is in place." }],
						stopReason: "stop",
						timestamp: tick(),
					},
				]),
	];
}
