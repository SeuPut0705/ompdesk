/**
 * The desktop slot's bridge side (contract: ./desktop-slot-contracts.ts, rules: ./desktop-slot-core.ts): one omp
 * session at a time drives the desktop. The seam is stock's `ComputerSupervisor.prototype.run`, patched once at
 * install: a read-only run, or one stock keeps in the background (`needsSlot`), passes; an acting run needs the slot main owns (`desktop_slot_acquire` →
 * `desktop_slot.grant`) and one that had to wait returns the stale notice instead of running.
 *
 * Feature-detected: an omp whose supervisor lacks `run` or `revokeControl` is left untouched (stock behaviour,
 * reported by `capabilities` as the `desktopSlot` feature). Stock's `ComputerSupervisor` instances this process
 * runs (`this` of each patched call) are kept so a revoke can `revokeControl()` every one before main grants on.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as supervisorModule from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { hasPath } from "./capabilities";
import { DESKTOP_SLOT_REVOKED_NOTICE, DESKTOP_SLOT_STALE_NOTICE } from "./desktop-slot-contracts";
import { DesktopSlotCore, needsSlot, type RunSnapshot } from "./desktop-slot-core";
import { emit, errorMessage, record } from "./modes/shared";
import type { BridgeMethods } from "./types";

/** The stock controller members this module calls. */
interface SlotController {
	revokeControl?(): Promise<void>;
}

/** The part of stock's `ComputerRunOk` the tool card reads; a notice is one text display and nothing else. */
interface NoticeRun {
	displays: Array<{ type: "text"; text: string }>;
	returnValue: undefined;
	screenshots: [];
}

type RunArgs = [code: string, timeoutMs: number, snapshot: RunSnapshot, signal?: AbortSignal, context?: unknown];
type RunMethod = (this: SlotController, ...args: RunArgs) => Promise<unknown>;

/** The original `run`, kept on the patched prototype so a second install (a subagent's rebind) patches nothing. */
const ORIGINAL = Symbol.for("ompdesk.desktopSlot.originalRun");

const controllers = new Set<SlotController>();

const core = new DesktopSlotCore({
	emit,
	newId: () => crypto.randomUUID(),
	async revokeControllers() {
		// Every controller is tried, but one that rejects makes the whole revoke fail: the slot is handed on only when
		// stock confirmed the control stopped everywhere.
		const results = await Promise.allSettled([...controllers].map(controller => controller.revokeControl?.()));
		const failed = results.flatMap(result => (result.status === "rejected" ? [errorMessage(result.reason)] : []));
		if (failed.length > 0) throw new Error(`revokeControl failed: ${failed.join("; ")}`);
	},
});

function notice(text: string): NoticeRun {
	return { displays: [{ type: "text", text }], returnValue: undefined, screenshots: [] };
}

/** Patches `ComputerSupervisor.prototype.run` once; false (stock behaviour) when this omp lacks the seam. */
function patchSupervisor(pi: ExtensionAPI): boolean {
	// A vanished export reads as undefined through the namespace (the bridge is not type-checked against omp).
	const supervisor: unknown = supervisorModule.ComputerSupervisor;
	if (!hasPath(supervisor, "prototype.run()") || !hasPath(supervisor, "prototype.revokeControl()")) {
		pi.logger.warn("gui-bridge: desktop slot unavailable, ComputerSupervisor.run/revokeControl missing");
		return false;
	}
	const proto: Record<string | symbol, unknown> = Reflect.get(Object(supervisor), "prototype");
	if (proto[ORIGINAL]) return true;
	const original: RunMethod = Reflect.get(proto, "run");
	proto[ORIGINAL] = original;
	proto.run = function run(this: SlotController, ...args: RunArgs): Promise<unknown> {
		controllers.add(this);
		const [code, timeoutMs, snapshot, signal, context] = args;
		if (snapshot.readOnly) return core.runReadOnly(() => original.apply(this, args));
		return (needsSlot(snapshot) ? core.runActing.bind(core) : core.runBackground.bind(core))({
			signal,
			run: own => original.call(this, code, timeoutMs, snapshot, own, context),
			stale: () => notice(DESKTOP_SLOT_STALE_NOTICE),
			revoked: () => notice(DESKTOP_SLOT_REVOKED_NOTICE),
		});
	};
	return true;
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: ExtensionAPI): void {
	if (!patchSupervisor(pi)) return;
	pi.on("agent_end", (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		core
			.turnEnd()
			.catch(error =>
				pi.logger.warn("gui-bridge: desktop slot turn-end release failed", { error: errorMessage(error) }),
			);
	});
}

/** No `guard`: an omp without the seam never acquires, and a revoke there must still answer so main can go on. */
export const methods: BridgeMethods = {
	"desktop_slot.grant": async params => {
		const { requestId, waited } = record(params);
		if (typeof requestId !== "string") {
			throw new Error("desktop_slot.grant needs {requestId: string, waited: boolean}");
		}
		return { granted: core.grant(requestId, waited === true) };
	},
	"desktop_slot.revoke": async params => {
		await core.revoke(String(record(params).reason ?? "stop"));
		return { revoked: true };
	},
};
