/**
 * The check-control contract (`docs/design/check-control.md` §3 and §6) as main, the page, the agent tool and tests
 * read it: the mirror of `native/ompdesk/crates/core/src/checks/contract.rs`, which is the one source. Each schema
 * here is strict, and `checks-contract.test.ts` holds both to `contract-samples.json` (written by the Rust tests from
 * the Rust types): a field or word on one side only fails there.
 *
 * JSON: camelCase fields, a union is tagged by `kind`, a time is milliseconds since the epoch. A field §3 marks `?`
 * is left out when absent; one §3 types `| null` is always there.
 */
import { z } from "zod";

export const OS = ["macos", "windows", "linux"] as const;
/** `stale`: the poll window passed without a read. `offline`: the link to that computer is lost (zero capacity). */
export const POOL_STATES = ["live", "stale", "offline"] as const;
/** In admission order: a free slot goes to the oldest job of the first lane that has one. */
export const LANES = ["release", "land", "branch", "local"] as const;
export const TRIGGERS = ["push", "pull_request", "dispatch", "queue", "local"] as const;
export const RUN_VERDICTS = ["green", "red", "cancelled"] as const;
/** `held`: waiting in OMPdesk's own queue, not at GitHub. */
export const JOB_STATES = ["held", "queued", "running", "passed", "failed", "cancelled", "reused"] as const;
export const GATE_VERDICTS = ["green", "red", "running", "waiting"] as const;
export const POLICY_ACTIONS = [
	"cancel-superseded",
	"hold",
	"reuse",
	"place",
	"batch",
	"quarantine",
	"rerun-failed",
] as const;
export const POLICY_MODES = ["enforce", "advise"] as const;
export const QUEUE_STATES = ["waiting", "testing", "ready", "landing", "failed", "removed"] as const;
export const OUTCOMES = ["pass", "fail", "skip"] as const;
export const TEST_STATES = ["active", "quarantined", "cleared"] as const;
/** `unknown` whenever the facts are older than the poll window: never green from old data. */
export const ANSWER_VERDICTS = ["green", "red", "unknown"] as const;
/** What the agent does next; it follows this instead of judging the run itself. */
export const NEXTS = ["fix", "rerun-failed", "wait", "land", "ask-owner"] as const;
/** Why a check is started. The lane comes from it by policy, never from the caller. */
export const PURPOSES = ["branch", "release", "land"] as const;
export const START_SCOPES = ["changed", "full"] as const;
export const RERUNS = ["failed"] as const;
export const START_DECISIONS = ["started", "reused", "held", "refused"] as const;
/** `result`: the run's verdict. `any`: the first change of the run. */
export const UNTILS = ["result", "any"] as const;
export const STATUS_SCOPES = ["mine", "repo", "all"] as const;

/** Every enum by its Rust name, as `contract-samples.json` lists them. */
export const CHECKS_ENUMS = {
	Os: OS,
	PoolState: POOL_STATES,
	Lane: LANES,
	Trigger: TRIGGERS,
	RunVerdict: RUN_VERDICTS,
	JobState: JOB_STATES,
	GateVerdict: GATE_VERDICTS,
	PolicyAction: POLICY_ACTIONS,
	PolicyMode: POLICY_MODES,
	QueueState: QUEUE_STATES,
	Outcome: OUTCOMES,
	TestState: TEST_STATES,
	AnswerVerdict: ANSWER_VERDICTS,
	Next: NEXTS,
	Purpose: PURPOSES,
	StartScope: START_SCOPES,
	Rerun: RERUNS,
	StartDecision: START_DECISIONS,
	Until: UNTILS,
	StatusScope: STATUS_SCOPES,
} as const;

/** The agent tool and its CLI twin (`ompdesk checks <op>`). */
export const CHECKS_TOOL = "ompdesk_checks";
export const CHECKS_OPS = ["start", "wait", "status"] as const;
/** `wait` ends after the default, and never waits longer than the maximum. */
export const CHECKS_LIMITS = { waitDefaultSeconds: 600, waitMaxSeconds: 3600 } as const;

/**
 * The core's methods (main's requests, each with `hub`, main's id for the hub it opened) and its two events:
 * `snapshot` `{hub, snapshot}` at each change while `watch {on: true}` holds, `result` `{hub, result}` for every
 * result, whoever waits. `fake` drives a hub opened with `{fake: true}` (tests and the dev harness only).
 */
export const CHECKS_WIRE = {
	open: "checks.open",
	close: "checks.close",
	start: "checks.start",
	wait: "checks.wait",
	status: "checks.status",
	watch: "checks.watch",
	pause: "checks.pause",
	fake: "checks.fake",
	snapshot: "checks.snapshot",
	result: "checks.result",
} as const;

/** Milliseconds since the epoch. */
const Timestamp = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();

/** Where a job runs. */
export const WhereSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("device"), deviceId: z.string() }),
	z.strictObject({ kind: z.literal("github-hosted") }),
	z.strictObject({ kind: z.literal("self-hosted"), runnerId: z.string() }),
]);
export type Where = z.infer<typeof WhereSchema>;

/** Slot and capacity per OS and machine: one shape for a computer's heavy slots and for GitHub's macOS limit. */
export const PoolSchema = z.strictObject({
	id: z.string(),
	os: z.enum(OS),
	where: WhereSchema,
	limit: Count,
	running: Count,
	queued: Count,
	oldestWaitMs: Count,
	diskFreeGb: z.number().optional(),
	asOf: Timestamp,
	state: z.enum(POOL_STATES),
});
export type Pool = z.infer<typeof PoolSchema>;

/**
 * Who asked. Main-owned provenance, never read from text or tool arguments. `person`: a person started it (shown,
 * never governed). `outside`: a process over the control socket, the name its own claim. `foreign`: a run of another
 * repo or program that eats shared capacity (shown and counted, never touched).
 */
export const OriginSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("session"),
		session: z.string(),
		device: z.string(),
		goal: z.string().optional(),
	}),
	z.strictObject({ kind: z.literal("person") }),
	z.strictObject({ kind: z.literal("outside"), claimedName: z.string() }),
	z.strictObject({ kind: z.literal("foreign") }),
]);
export type Origin = z.infer<typeof OriginSchema>;

export const JobSchema = z.strictObject({
	id: z.string(),
	os: z.enum(OS),
	pool: z.string(),
	state: z.enum(JOB_STATES),
	queuedAt: Timestamp,
	startedAt: Timestamp.optional(),
	endedAt: Timestamp.optional(),
	billedMin: z.number().optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const RunSchema = z.strictObject({
	id: z.string(),
	/** `owner/name`. */
	repo: z.string(),
	ref: z.string(),
	sha: z.string(),
	lane: z.enum(LANES),
	trigger: z.enum(TRIGGERS),
	origin: OriginSchema,
	gate: z.string().optional(),
	jobs: z.array(JobSchema),
	verdict: z.enum(RUN_VERDICTS).optional(),
	reusedFrom: z.string().optional(),
	supersededBy: z.string().optional(),
	/** What a result may be reused on: commit, workflow file hash, inputs and tool digest. Never the sha alone. */
	digest: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

/** A named set of jobs a release needs: a workflow file and the job names in it (empty: every job). */
export const GateSchema = z.strictObject({
	id: z.string(),
	release: z.string(),
	jobs: z.strictObject({ workflow: z.string(), jobs: z.array(z.string()) }),
	required: z.boolean(),
});
export type Gate = z.infer<typeof GateSchema>;

/** A gate as the board shows it: where it stands and the run that decides it. */
export const GateStatusSchema = z.strictObject({
	gate: GateSchema,
	state: z.enum(GATE_VERDICTS),
	run: z.string().optional(),
});
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const PolicySchema = z.strictObject({
	id: z.string(),
	/** `global`, or the repo it holds for. */
	scope: z.string(),
	when: z.string(),
	action: z.enum(POLICY_ACTIONS),
	mode: z.enum(POLICY_MODES),
	ownerOverride: z.boolean().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

/** One line of the "Decided automatically" log. */
export const DecisionSchema = z.strictObject({
	policy: z.string(),
	run: z.string(),
	action: z.string(),
	reason: z.string(),
	at: Timestamp,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const QueueEntrySchema = z.strictObject({
	id: z.string(),
	repo: z.string(),
	base: z.string(),
	pr: Count,
	sha: z.string(),
	lane: z.enum(LANES),
	position: Count,
	batch: z.string().optional(),
	state: z.enum(QUEUE_STATES),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const TestResultSchema = z.strictObject({
	/** hash(repo, fully qualified test name). */
	test: z.string(),
	run: z.string(),
	outcome: z.enum(OUTCOMES),
	durationMs: Count,
	digest: z.string(),
	attempt: Count,
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const TestHistorySchema = z.strictObject({
	test: z.string(),
	/** The name a person reads (file and titles). */
	name: z.string(),
	p50Ms30d: Count,
	state: z.enum(TEST_STATES),
	quarantinedBy: OriginSchema.optional(),
	/** Clean runs on different inputs so far, of the 5 that clear it. */
	cleanSince: Count,
});
export type TestHistory = z.infer<typeof TestHistorySchema>;

/** What an agent receives. It carries the judgment, so the agent never reads logs. */
export const AnswerSchema = z.strictObject({
	runId: z.string(),
	verdict: z.enum(ANSWER_VERDICTS),
	asOf: Timestamp,
	counts: z.strictObject({ passed: Count, failed: Count }),
	failed: z.array(
		z.strictObject({
			test: z.string(),
			firstError: z.string(),
			knownFlaky: z.boolean(),
			/** Its record in words ("failed 3 of the last 20 runs on unchanged inputs"). */
			history: z.string(),
		}),
	),
	blocksRelease: z.strictObject({ gate: z.string() }).nullable(),
	expectedWaitMin: Count.nullable(),
	reused: z.strictObject({ from: z.string(), savedMin: Count }).optional(),
	next: z.enum(NEXTS),
	notes: z.array(z.string()),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** `start`. No placement or lane argument: policy decides both and reports them back. `cwd` is main's, never the tool's. */
export const StartRequestSchema = z.strictObject({
	purpose: z.enum(PURPOSES),
	scope: z.enum(START_SCOPES),
	rerun: z.enum(RERUNS).optional(),
	repo: z.string().optional(),
	ref: z.string().optional(),
	cwd: z.string().optional(),
});
export type StartRequest = z.infer<typeof StartRequestSchema>;

/** `runId` is null only for `refused`. */
export const StartReplySchema = z.strictObject({
	runId: z.string().nullable(),
	decision: z.enum(START_DECISIONS),
	placement: WhereSchema.nullable(),
	expectedStartMin: Count.nullable(),
	reason: z.string(),
});
export type StartReply = z.infer<typeof StartReplySchema>;

/** `wait`. A wait that ran out answers `verdict: unknown, next: wait`, never an error. */
export const WaitRequestSchema = z.strictObject({
	runId: z.string(),
	until: z.enum(UNTILS),
	timeoutSeconds: z.number().int().min(1).max(CHECKS_LIMITS.waitMaxSeconds).optional(),
});
export type WaitRequest = z.infer<typeof WaitRequestSchema>;

export const StatusRequestSchema = z.strictObject({
	scope: z.enum(STATUS_SCOPES),
	repo: z.string().optional(),
	cwd: z.string().optional(),
});
export type StatusRequest = z.infer<typeof StatusRequestSchema>;

/** A run's result with who started it: the event main wakes that session on, and the board's "last answer". */
export const RunResultSchema = z.strictObject({ runId: z.string(), origin: OriginSchema, answer: AnswerSchema });
export type RunResult = z.infer<typeof RunResultSchema>;

/** The "Tests and cost" tab (empty until P4 fills it). */
export const TrendsSchema = z.strictObject({
	tests: z.array(TestHistorySchema),
	slowdowns: z.array(z.strictObject({ test: z.string(), name: z.string(), p50Ms30d: Count, lastMs: z.array(Count) })),
	/** `month`: `YYYY-MM`. */
	minutes: z.array(z.strictObject({ os: z.enum(OS), month: z.string(), minutes: z.number() })),
	queueDepth: z.array(z.strictObject({ at: Timestamp, pool: z.string(), queued: Count })),
});
export type Trends = z.infer<typeof TrendsSchema>;

/** Everything `status` answers and `watch` streams: the hub's cache at `asOf`. It costs no GitHub request. */
export const SnapshotSchema = z.strictObject({
	asOf: Timestamp,
	/** The owner paused admission: every start is refused with "paused by the owner". */
	paused: z.boolean(),
	pools: z.array(PoolSchema),
	runs: z.array(RunSchema),
	gates: z.array(GateStatusSchema),
	queue: z.array(QueueEntrySchema),
	decisions: z.array(DecisionSchema),
	answers: z.array(RunResultSchema),
	/** "Are agents using it?" (§7 criterion 5). */
	adoption: z.strictObject({ started: Count, refused: Count, polls: Count, wrongGreens: Count }),
	trends: TrendsSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** What `checks.fake` takes (the scripted hub of tests and the dev harness). */
export const FakeOpSchema = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("snapshot"), snapshot: SnapshotSchema }),
	z.strictObject({ op: z.literal("startReply"), reply: StartReplySchema }),
	z.strictObject({ op: z.literal("finish"), result: RunResultSchema }),
	z.strictObject({ op: z.literal("calls") }),
]);
export type FakeOp = z.infer<typeof FakeOpSchema>;

/** A call the fake hub got: `op` is `start`, `wait`, `status` or `pause`. */
export const FakeCallSchema = z.strictObject({ op: z.string(), origin: OriginSchema.nullable(), request: z.unknown() });
export type FakeCall = z.infer<typeof FakeCallSchema>;

/** Every shape by its Rust name, as `contract-samples.json` lists them. */
export const CHECKS_SCHEMAS = {
	Where: WhereSchema,
	Origin: OriginSchema,
	Pool: PoolSchema,
	Job: JobSchema,
	Run: RunSchema,
	Gate: GateSchema,
	Policy: PolicySchema,
	TestResult: TestResultSchema,
	TestHistory: TestHistorySchema,
	Answer: AnswerSchema,
	StartRequest: StartRequestSchema,
	StartReply: StartReplySchema,
	WaitRequest: WaitRequestSchema,
	StatusRequest: StatusRequestSchema,
	RunResult: RunResultSchema,
	Snapshot: SnapshotSchema,
	FakeOp: FakeOpSchema,
	FakeCall: FakeCallSchema,
} as const;

/**
 * The hub as TypeScript code asks it: main's client of the core (`src/main/checks/client.ts`) and the in-memory fake
 * (`checks-fixture.ts`) both are one. `origin` is main's word for who asks.
 */
export interface ChecksHub {
	start(origin: Origin, request: StartRequest): Promise<StartReply>;
	/** Ends when the result arrived, the wait ran out (`verdict: unknown`) or `signal` aborted (it then rejects). */
	wait(origin: Origin, request: WaitRequest, signal?: AbortSignal): Promise<Answer>;
	status(origin: Origin, request: StatusRequest): Promise<Snapshot>;
	/** The whole cache now and at each change; returns the unsubscribe. */
	watch(listener: (snapshot: Snapshot) => void): () => void;
	/** Every result as it arrives, whoever waits; returns the unsubscribe. */
	onResult(listener: (result: RunResult) => void): () => void;
	pause(paused: boolean): Promise<void>;
}

export function emptySnapshot(asOf: number): Snapshot {
	return {
		asOf,
		paused: false,
		pools: [],
		runs: [],
		gates: [],
		queue: [],
		decisions: [],
		answers: [],
		adoption: { started: 0, refused: 0, polls: 0, wrongGreens: 0 },
		trends: { tests: [], slowdowns: [], minutes: [], queueDepth: [] },
	};
}
