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
/** Why a policy acted, as a code the screens translate (`DecisionWhySchema`). */
export const WHY_CODES = [
	"newer-run",
	"pool-full",
	"release-ahead",
	"paused",
	"green-on-same-inputs",
	"placed-on",
	"batched",
	"flaky",
	"failed-jobs",
	"other",
] as const;
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
	WhyCode: WHY_CODES,
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
	/** `{hub, fact}`: what main knows and the hub cannot read itself (`MainFact`). */
	facts: "checks.facts",
	/** `{hub, gh, git, home}`: how gh and git run (main's runners, null when not installed). Never logged. */
	runners: "checks.runners",
	/** `{hub}` → this computer's own `LocalPool`, which a paired computer's link forwards as `devicePool`. */
	localPool: "checks.localPool",
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

/** Heavy work on a computer that holds none of its slots (another project's own lock, a plain terminal). Never managed. */
export const ForeignLoadSchema = z.strictObject({
	/** `cargo`, `godot`, `vitest`, `playwright`. */
	kind: z.string(),
	/** The topmost process of the work. */
	pid: Count,
	/** Its command line, cut to 200 characters. */
	command: z.string(),
	/** The processes of its tree that are that kind. */
	processes: Count,
});
export type ForeignLoad = z.infer<typeof ForeignLoadSchema>;

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
	/** Heavy work there that holds none of its slots: the load is `running + foreign.length` against `limit`. */
	foreign: z.array(ForeignLoadSchema),
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
		/** The saved id (the id in the session file's name, `savedIdOfPath`); a session with no file yet goes by its tab id. */
		session: z.string(),
		/** `local` for the hub's own computer, else the paired device's OMPdesk id. */
		device: z.string(),
		/** The goal's own short text as its computer knew it at the start: shown as written, never looked up. */
		goal: z.string().optional(),
	}),
	z.strictObject({ kind: z.literal("person") }),
	z.strictObject({ kind: z.literal("outside"), claimedName: z.string() }),
	z.strictObject({ kind: z.literal("foreign") }),
]);
export type Origin = z.infer<typeof OriginSchema>;

export const JobSchema = z.strictObject({
	id: z.string(),
	/** The workflow job's name (`mac-smoke`, `check (node 1/2)`), as a gate's `jobs` list it. */
	name: z.string(),
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

/** Why a policy acted: what a screen shows, translated from its code (`reason` stays English for agents and logs). */
export const DecisionWhySchema = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("newer-run"), run: z.string() }),
	z.strictObject({ code: z.literal("pool-full"), pool: z.string(), running: Count, limit: Count }),
	z.strictObject({ code: z.literal("release-ahead"), pool: z.string(), running: Count, limit: Count }),
	z.strictObject({ code: z.literal("paused") }),
	z.strictObject({ code: z.literal("green-on-same-inputs"), run: z.string() }),
	z.strictObject({ code: z.literal("placed-on"), pool: z.string() }),
	z.strictObject({ code: z.literal("batched"), batch: z.string() }),
	z.strictObject({ code: z.literal("flaky"), fails: Count, runs: Count }),
	z.strictObject({ code: z.literal("failed-jobs"), count: Count }),
	z.strictObject({ code: z.literal("other") }),
]);
export type DecisionWhy = z.infer<typeof DecisionWhySchema>;

/** One line of the "Decided automatically" log. */
export const DecisionSchema = z.strictObject({
	policy: z.string(),
	run: z.string(),
	action: z.enum(POLICY_ACTIONS),
	reason: z.string(),
	why: DecisionWhySchema,
	at: Timestamp,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const QueueEntrySchema = z.strictObject({
	id: z.string(),
	repo: z.string(),
	base: z.string(),
	/** The branch that lands. */
	branch: z.string(),
	/** Its pull request, when it has one (a repo may land branches without). */
	pr: Count.optional(),
	/** What lands, in a line: the pull request's title, else the subject of the branch's newest commit. */
	title: z.string(),
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
	/** Quarantine is per OS: a test that flakes on Windows is not suspect on Linux. */
	os: z.enum(OS),
	p50Ms30d: Count,
	runs7d: Count,
	fails7d: Count,
	state: z.enum(TEST_STATES),
	/** The inputs it both passed and failed on. */
	flakedOn: z.string().optional(),
	quarantinedAt: Timestamp.optional(),
	clearedAt: Timestamp.optional(),
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

/** A workflow run the caller names (`ompdesk checks start --workflow`, what `scripts/ci-run.ts` sends); the agent tool has none. */
export const WorkflowAskSchema = z.strictObject({
	file: z.string(),
	inputs: z.record(z.string(), z.string()),
	macos: z.boolean(),
});
export type WorkflowAsk = z.infer<typeof WorkflowAskSchema>;

/** `start`. No placement or lane argument: policy decides both and reports them back. `cwd` is main's, never the tool's. */
export const StartRequestSchema = z.strictObject({
	purpose: z.enum(PURPOSES),
	scope: z.enum(START_SCOPES),
	rerun: z.enum(RERUNS).optional(),
	repo: z.string().optional(),
	ref: z.string().optional(),
	cwd: z.string().optional(),
	workflow: WorkflowAskSchema.optional(),
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
	slowdowns: z.array(
		z.strictObject({
			test: z.string(),
			name: z.string(),
			os: z.enum(OS),
			p50Ms30d: Count,
			/** The recent durations, oldest first; the last three are the slow runs. */
			lastMs: z.array(Count),
			/** The commit of the first slow run. */
			sinceSha: z.string().optional(),
		}),
	),
	/** `month`: `YYYY-MM`. `costUsd`: the minutes at GitHub's published rate for the runner (an estimate, not a bill). */
	minutes: z.array(z.strictObject({ os: z.enum(OS), month: z.string(), minutes: z.number(), costUsd: z.number() })),
	queueDepth: z.array(z.strictObject({ at: Timestamp, pool: z.string(), queued: Count })),
	/** Time lost to flaky failures in the last 7 days, and in the 7 before. */
	lostMs7d: Count,
	lostMsPrev7d: Count,
	savedByRerunMs7d: Count,
	savedByReuseMs7d: Count,
	/** What the check logs and the reuse store hold on disk. */
	storeBytes: Count.optional(),
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

/** A computer's heavy pool (`ompdesk heavy status --json`), as that computer answers it. */
export const LocalPoolSchema = z.strictObject({
	device: z.string(),
	os: z.enum(OS),
	slots: Count,
	held: Count,
	queued: Count,
	oldestWaitMs: Count,
	/** `low`: under `min_free`, so no heavy work starts on it. */
	volumes: z.array(z.strictObject({ path: z.string(), freeGb: z.number(), totalGb: z.number(), low: z.boolean() })),
	asOf: Timestamp,
	/** The paired link to that computer is lost: zero capacity, shown as `offline`, never as empty. */
	offline: z.boolean(),
	/** The size of that computer's check store. */
	checkStoreBytes: Count.optional(),
	/** Heavy work there that holds none of its slots (an older computer's answer leaves it out). */
	foreign: z.array(ForeignLoadSchema).default([]),
});
export type LocalPool = z.infer<typeof LocalPoolSchema>;

/**
 * What main knows and the hub cannot read itself; main says it again whenever it changes. `repos`: those of the open
 * sessions' checkouts. `devicePool`: a paired computer's pool, as it answered over the link. `deviceOffline`: that
 * link is lost. `sessions`: whose each session tag is, so a local check run names the session that started it.
 */
export const MainFactSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("repos"), repos: z.array(z.string()) }),
	z.strictObject({ kind: z.literal("devicePool"), pool: LocalPoolSchema }),
	z.strictObject({ kind: z.literal("deviceOffline"), device: z.string() }),
	z.strictObject({ kind: z.literal("sessions"), tags: z.record(OriginSchema) }),
]);
export type MainFact = z.infer<typeof MainFactSchema>;

/** What `checks.fake` takes (the scripted hub of tests and the dev harness). */
export const FakeOpSchema = z.discriminatedUnion("op", [
	z.strictObject({ op: z.literal("snapshot"), snapshot: SnapshotSchema }),
	z.strictObject({ op: z.literal("startReply"), reply: StartReplySchema }),
	z.strictObject({ op: z.literal("finish"), result: RunResultSchema }),
	z.strictObject({ op: z.literal("calls") }),
]);
export type FakeOp = z.infer<typeof FakeOpSchema>;

/**
 * A call the fake hub got: `op` is `start`, `wait`, `status`, `pause`, `told` (the request is the fact) or `runners`
 * (the request says only which of gh and git came).
 */
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
	DecisionWhy: DecisionWhySchema,
	TestResult: TestResultSchema,
	TestHistory: TestHistorySchema,
	Answer: AnswerSchema,
	StartRequest: StartRequestSchema,
	StartReply: StartReplySchema,
	WaitRequest: WaitRequestSchema,
	StatusRequest: StatusRequestSchema,
	RunResult: RunResultSchema,
	Snapshot: SnapshotSchema,
	LocalPool: LocalPoolSchema,
	MainFact: MainFactSchema,
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
	/** What main knows and the hub cannot read itself. */
	told(fact: MainFact): Promise<void>;
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
		trends: {
			tests: [],
			slowdowns: [],
			minutes: [],
			queueDepth: [],
			lostMs7d: 0,
			lostMsPrev7d: 0,
			savedByRerunMs7d: 0,
			savedByReuseMs7d: 0,
		},
	};
}
