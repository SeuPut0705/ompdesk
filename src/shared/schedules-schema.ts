/**
 * The schedules' shapes as a link or a desk carries them (zod), one copy for the paired-host protocol
 * (`main/remote/app-protocol.ts`) and the bot's desk (`shared/bot-desk.ts`, its routines). The rules a draft must
 * keep are `scheduleDraftProblem`'s, checked by the service that saves it.
 */
import { z } from "zod";
import {
	GITHUB_EVENT_KINDS,
	type ScheduleEvent,
	type ScheduleFrequency,
	type ScheduleRun,
	SESSION_EVENT_KINDS,
} from "./schedules";

const Path = z.string().max(4096);

export const ScheduleEventSchema: z.ZodType<ScheduleEvent> = z.discriminatedUnion("source", [
	z.object({ source: z.literal("webhook"), key: z.string().max(200) }),
	z.object({
		source: z.literal("github"),
		repo: z.string().max(200),
		events: z.array(z.enum(GITHUB_EVENT_KINDS)).max(GITHUB_EVENT_KINDS.length),
	}),
	z.object({ source: z.literal("files"), path: Path }),
	z.object({ source: z.literal("git"), repo: Path, branch: z.string().max(250) }),
	z.object({
		source: z.literal("session"),
		events: z.array(z.enum(SESSION_EVENT_KINDS)).max(SESSION_EVENT_KINDS.length),
		folder: z.string().max(4096).optional(),
	}),
]);

export const ScheduleFrequencySchema: z.ZodType<ScheduleFrequency> = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("interval"), minutes: z.number().int() }),
	z.object({ kind: z.literal("daily"), time: z.string().max(5), days: z.array(z.number().int()).max(7) }),
	z.object({ kind: z.literal("once"), at: z.string().max(40) }),
	z.object({ kind: z.literal("event"), event: ScheduleEventSchema }),
]);

export const ScheduleRunSchema: z.ZodType<ScheduleRun> = z.object({
	id: z.string(),
	scheduleId: z.string(),
	trigger: z.enum(["schedule", "manual", "event"]),
	startedAt: z.string(),
	endedAt: z.string().nullable(),
	status: z.enum(["running", "succeeded", "failed", "stopped", "skipped"]),
	exitCode: z.number().nullable(),
	error: z.string().nullable(),
	detail: z.string().optional(),
});
