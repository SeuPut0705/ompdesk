import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleDraft, ScheduleEvent } from "../../shared/schedules";
import { type RunLauncher, type RunProcess, ScheduleService } from "../schedules";
import { RM_TEMP } from "../test-fake-omp";
import type { MailPort } from "./email";
import { FILES_DEBOUNCE_MS } from "./files";
import type { GitPort } from "./git";
import type { GhApi } from "./github";
import type { SessionPorts } from "./sessions";
import { fakeWatch } from "./test-context";
import { RoutineTriggers } from "./triggers";

const QUIET_MS = 3_000;
const dirs: string[] = [];
let dir: string;
let service: ScheduleService;
let triggers: RoutineTriggers;
let watch: ReturnType<typeof fakeWatch>;
let launched: { prompt: string; finish: (code: number) => void }[];
let githubCalls: string[];
/** The accounts the email sources asked for (no mail account exists: each poll asks once). */
let mailAsked: string[];
const NO_MAIL: MailPort = {
	account: name => {
		mailAsked.push(name);
		return null;
	},
	read: async () => {
		throw new Error("no mailbox in this test");
	},
};
let gitCalls: string[];
let observers: Set<unknown>;
const logs: string[] = [];

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date(2026, 10, 1, 12, 0) });
	dir = await mkdtemp(join(tmpdir(), "routine-triggers-"));
	dirs.push(dir);
	watch = fakeWatch();
	launched = [];
	githubCalls = [];
	mailAsked = [];
	gitCalls = [];
	logs.length = 0;
	observers = new Set();
	const launch: RunLauncher = async (_schedule, files): Promise<RunProcess> => {
		const { promise, resolve } = Promise.withResolvers<{ code: number }>();
		launched.push({ prompt: await readFile(files.prompt, "utf8"), finish: code => resolve({ code }) });
		return { stop: () => resolve({ code: 130 }), done: promise };
	};
	const github: GhApi = async endpoint => {
		githubCalls.push(endpoint);
		return [];
	};
	const git: GitPort = {
		head: async (_repo, branch) => {
			gitCalls.push(`head ${branch}`);
			return "abc";
		},
		commits: async () => ({ total: 0, lines: [] }),
	};
	const sessions: SessionPorts = {
		observeTabs: observer => {
			observers.add(observer);
			return () => observers.delete(observer);
		},
		tabs: () => [],
		botPath: () => null,
	};
	service = new ScheduleService({
		file: join(dir, "schedules.json"),
		logDir: join(dir, "runs"),
		launch,
		onState: () => triggers?.sync(),
		tickMs: 3_600_000,
	});
	triggers = new RoutineTriggers({
		service,
		log: message => logs.push(message),
		github,
		watch: watch.watch,
		git,
		sessions,
		mail: NO_MAIL,
		quietMs: QUIET_MS,
	});
	await service.start();
});

afterEach(async () => {
	triggers.dispose();
	service.dispose();
	vi.useRealTimers();
	// A schedule save still in flight at dispose may write and drop its temp file while the folder goes.
	for (const path of dirs.splice(0)) await rm(path, RM_TEMP);
});

const draft = (event: ScheduleEvent, extra: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
	name: "Routine",
	prompt: "Do the thing",
	cwd: dir,
	frequency: { kind: "event", event },
	model: null,
	autoApprove: false,
	enabled: true,
	...extra,
});
const filesDraft = (path = "/watched") => draft({ source: "files", path });

describe("RoutineTriggers", () => {
	it("keeps one live source per enabled event schedule and follows enable, disable, edit and delete", async () => {
		const { id } = await service.create(filesDraft("/a"));
		expect(watch.live().map(item => item.path)).toEqual(["/a"]);

		await service.command({ action: "setEnabled", id, enabled: false });
		expect(watch.live()).toHaveLength(0);
		await service.command({ action: "setEnabled", id, enabled: true });
		expect(watch.live().map(item => item.path)).toEqual(["/a"]);

		// A name change keeps the watcher; a changed trigger replaces it.
		await service.command({ action: "save", id, draft: { ...filesDraft("/a"), name: "Renamed" } });
		expect(watch.watchers).toHaveLength(2);
		await service.command({ action: "save", id, draft: filesDraft("/b") });
		expect(watch.live().map(item => item.path)).toEqual(["/b"]);

		await service.command({ action: "delete", id });
		expect(watch.live()).toHaveLength(0);
	});

	it("starts sources for every kind, none for a webhook, a timed schedule or a disabled routine", async () => {
		await service.create(draft({ source: "github", repo: "o/r", events: ["pull_request"] }));
		await service.create(draft({ source: "git", repo: dir, branch: "main" }));
		await service.create(draft({ source: "session", events: ["done"] }));
		await service.create(draft({ source: "email", account: "Work", to: "owner+bot@" }));
		await service.create(draft({ source: "webhook", key: "" }));
		await service.create({ ...filesDraft(), frequency: { kind: "interval", minutes: 30 } });
		await service.create({ ...filesDraft("/off"), enabled: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(githubCalls).toEqual(["repos/o/r/pulls?state=all&sort=created&direction=desc&per_page=20"]);
		expect(gitCalls).toEqual(["head main"]);
		expect(observers.size).toBe(1);
		expect(mailAsked).toEqual(["Work"]);
		expect(watch.watchers).toHaveLength(0);
	});

	it("stops every source while everything is paused and starts them again, with new baselines, after", async () => {
		await service.create(filesDraft());
		await service.create(draft({ source: "session", events: ["done"] }));
		await service.command({ action: "setPaused", paused: true });
		expect(watch.live()).toHaveLength(0);
		expect(observers.size).toBe(0);
		await service.command({ action: "setPaused", paused: false });
		expect(watch.live()).toHaveLength(1);
		expect(observers.size).toBe(1);
	});

	it("runs the routine once for a burst of file changes, with the changed paths in its prompt", async () => {
		const { id } = await service.create(filesDraft());
		watch.emit("src/a.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		await vi.waitFor(() => expect(launched).toHaveLength(1));
		expect(launched[0]?.prompt).toContain("What fired this run:\nsrc/a.ts changed");
		expect(service.state().runs.find(run => run.scheduleId === id)?.trigger).toBe("event");
	});

	it("takes what its own run writes, and the three seconds after it, for nothing", async () => {
		await service.create(filesDraft());
		watch.emit("src/a.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		await vi.waitFor(() => expect(launched).toHaveLength(1));

		watch.emit("out/result.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(launched).toHaveLength(1);

		launched[0]?.finish(0);
		await vi.waitFor(() => expect(service.state().runs[0]?.status).toBe("succeeded"));
		watch.emit("out/late.txt");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS * 2);
		expect(launched).toHaveLength(1);
		expect(service.state().runs).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(QUIET_MS);
		watch.emit("src/b.ts");
		await vi.advanceTimersByTimeAsync(FILES_DEBOUNCE_MS);
		await vi.waitFor(() => expect(launched).toHaveLength(2));
		expect(launched[1]?.prompt).toContain("src/b.ts changed");
	});

	it("tells a git source its routine's run ended, so the branch as it stands becomes the baseline", async () => {
		let head = "aaa";
		const heads: string[] = [];
		const git: GitPort = {
			head: async () => {
				heads.push(head);
				return head;
			},
			commits: async () => ({ total: 1, lines: ["bbb change"] }),
		};
		triggers.dispose();
		triggers = new RoutineTriggers({
			service,
			log: () => undefined,
			github: async () => [],
			watch: watch.watch,
			git,
			sessions: { observeTabs: () => () => undefined, tabs: () => [], botPath: () => null },
			mail: NO_MAIL,
			quietMs: QUIET_MS,
		});
		const { id } = await service.create(draft({ source: "git", repo: dir, branch: "main" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(heads).toEqual(["aaa"]);

		await service.command({ action: "runNow", id });
		await vi.waitFor(() => expect(launched).toHaveLength(1));
		head = "bbb";
		launched[0]?.finish(0);
		await vi.waitFor(() => expect(heads).toEqual(["aaa", "bbb"]));
		expect(service.state().runs.filter(run => run.trigger === "event")).toHaveLength(0);
	});

	it("stops everything on dispose and ignores later changes", async () => {
		await service.create(filesDraft());
		await service.create(draft({ source: "session", events: ["done"] }));
		triggers.dispose();
		expect(watch.live()).toHaveLength(0);
		expect(observers.size).toBe(0);
		await service.create(filesDraft("/later"));
		expect(watch.live()).toHaveLength(0);
	});

	it("tells the log when a source cannot start, and starts the others", async () => {
		watch.control.missing = true;
		await service.create(filesDraft("/missing"));
		await service.create(draft({ source: "session", events: ["done"] }));
		expect(logs.filter(line => line.includes("ENOENT"))).toHaveLength(1);
		expect(observers.size).toBe(1);
	});
});
