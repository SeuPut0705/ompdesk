import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AGENT_CONTROL_VIEW, type AgentControlViewEvent } from "../../shared/agent-control";
import type { ClientWindow } from "../web/client-window";
import { LocalViewHost, type LocalViewSurface } from "./view-host";

function setup(web = false) {
	const requests: AgentControlViewEvent[] = [];
	const win: ClientWindow = {
		webContents: {
			id: 2,
			send(channel, payload) {
				if (channel === AGENT_CONTROL_VIEW)
					requests.push(
						z.object({ tabId: z.string(), how: z.literal("close"), closeRequest: z.string() }).parse(payload),
					);
			},
		},
		isDestroyed: () => false,
		once: () => undefined,
		removeListener: () => undefined,
	};
	const surface: LocalViewSurface = {
		win,
		facts: {
			handle: { viewHost: "B", window: "2", tabId: "relay", session: "saved", incarnation: "first" },
			tab: {
				tabId: "relay",
				sessionPath: "/sessions/time_saved.jsonl",
				title: "Finished",
				cwd: "/project",
				status: "ready",
				busy: false,
				asks: [],
				hidden: false,
			},
			enabled: true,
			manageEnabled: true,
			fullEnabled: true,
		},
	};
	let surfaces = [surface];
	const beforeCommit = vi.fn(async () => () => true);
	const close = vi.fn(
		async (selected: LocalViewSurface, guard: () => boolean, prepare: () => Promise<() => boolean>) => {
			const authorized = await prepare();
			if (!guard() || !authorized()) return false;
			surfaces = surfaces.filter(
				item => item.win !== selected.win || item.facts.handle.incarnation !== selected.facts.handle.incarnation,
			);
			return true;
		},
	);
	const host = new LocalViewHost({ surfaces: () => surfaces, close, isWeb: () => web, timeoutMs: 100 });
	return {
		host,
		win,
		surface,
		requests,
		close,
		beforeCommit,
		setSurfaces: (rows: LocalViewSurface[]) => {
			surfaces = rows;
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("one exact local view acknowledgement", () => {
	it("only accepts the selected window's single-use acknowledgement and confirms actual removal", async () => {
		const rig = setup();
		const done = rig.host.close(rig.surface.facts.handle, rig.surface.facts, rig.beforeCommit);
		const token = rig.requests[0]?.closeRequest;
		expect(token).toBeTypeOf("string");
		if (!token) throw new Error("missing close request");
		const other = { ...rig.win, webContents: { ...rig.win.webContents, id: 3 } };
		expect(await rig.host.complete(other, "relay", token, false)).toBe(false);
		expect(rig.close).not.toHaveBeenCalled();
		expect(await rig.host.complete(rig.win, "relay", token, false)).toBe(true);
		await done;
		expect(rig.host.list()).toEqual([]);
		expect(await rig.host.complete(rig.win, "relay", token, false)).toBe(false);
	});

	it.each(["dirty", "busy", "reopened", "permissions", "draft", "waiting"])(
		"refuses a view changed before the window responds (%s)",
		async change => {
			const rig = setup();
			rig.surface.facts.tab.userTouched = true;
			const done = rig.host.close(rig.surface.facts.handle, structuredClone(rig.surface.facts), rig.beforeCommit);
			const rejected = expect(done).rejects.toThrow("changed");
			const token = rig.requests[0]?.closeRequest;
			if (!token) throw new Error("missing close request");
			if (change === "dirty") rig.surface.facts.tab.webEdits = "dirty";
			if (change === "busy") rig.surface.facts.tab.busy = true;
			if (change === "reopened") rig.surface.facts.handle.incarnation = "second";
			if (change === "permissions") rig.surface.facts.manageEnabled = false;
			if (change === "draft") rig.surface.facts.tab.drafting = true;
			if (change === "waiting") rig.surface.facts.tab.status = "waiting";
			expect(await rig.host.complete(rig.win, "relay", token, false)).toBe(false);
			await rejected;
			expect(rig.close).not.toHaveBeenCalled();
			expect(rig.host.list()).toHaveLength(1);
		},
	);

	it("rechecks the guarded detach after an awaited exit-policy read", async () => {
		const rig = setup(true);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		rig.close.mockImplementation(async (_surface, guard) => {
			entered.resolve();
			await resume.promise;
			return guard();
		});
		const done = rig.host.close(rig.surface.facts.handle, structuredClone(rig.surface.facts), rig.beforeCommit);
		const rejected = expect(done).rejects.toThrow("not closed");
		await entered.promise;
		rig.surface.facts.tab.busy = true;
		resume.resolve();
		await rejected;
		expect(rig.host.list()[0]?.tab.busy).toBe(true);
	});

	it("never treats a callback success with the exact surface still present as Closed", async () => {
		const rig = setup(true);
		rig.close.mockResolvedValue(true);
		await expect(rig.host.close(rig.surface.facts.handle, rig.surface.facts, rig.beforeCommit)).rejects.toThrow(
			"not closed",
		);
		expect(rig.host.list()).toHaveLength(1);
	});

	it("keeps the selected surface when final source authorization refuses after renderer preparation", async () => {
		const rig = setup();
		rig.beforeCommit.mockRejectedValue(new Error("caller revoked"));
		const done = rig.host.close(rig.surface.facts.handle, rig.surface.facts, rig.beforeCommit);
		const rejected = expect(done).rejects.toThrow("caller revoked");
		const token = rig.requests[0]?.closeRequest;
		if (!token) throw new Error("missing close request");
		expect(rig.beforeCommit).not.toHaveBeenCalled();
		expect(await rig.host.complete(rig.win, "relay", token, false)).toBe(false);
		await rejected;
		expect(rig.beforeCommit).toHaveBeenCalledOnce();
		expect(rig.host.list()).toEqual([rig.surface.facts]);
	});

	it("expires an unanswered request without a later release", async () => {
		vi.useFakeTimers();
		const rig = setup();
		const done = rig.host.close(rig.surface.facts.handle, rig.surface.facts, rig.beforeCommit);
		const rejected = expect(done).rejects.toThrow("did not confirm");
		const token = rig.requests[0]?.closeRequest;
		if (!token) throw new Error("missing close request");
		await vi.advanceTimersByTimeAsync(100);
		await rejected;
		expect(await rig.host.complete(rig.win, "relay", token, false)).toBe(false);
		expect(rig.close).not.toHaveBeenCalled();
	});
});
