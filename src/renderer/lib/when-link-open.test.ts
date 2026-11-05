import { describe, expect, it, vi } from "vitest";
import type { WsConnectionState } from "../web/ws-transport";
import { whenLinkOpen } from "./when-link-open";

function link(initial: WsConnectionState) {
	let state = initial;
	const listeners = new Set<(state: WsConnectionState) => void>();
	return {
		runtime: {
			connectionState: () => state,
			onConnectionState: (listener: (state: WsConnectionState) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		set(next: WsConnectionState) {
			state = next;
			for (const listener of [...listeners]) listener(next);
		},
		listening: () => listeners.size,
	};
}

describe("whenLinkOpen", () => {
	it("runs at once in a desktop window and on an open link", () => {
		const run = vi.fn();
		whenLinkOpen(null, run);
		whenLinkOpen(link("open").runtime, run);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("waits out an outage and runs once when the link opens", () => {
		const run = vi.fn();
		const wire = link("connecting");
		whenLinkOpen(wire.runtime, run);
		wire.set("reconnecting" as WsConnectionState);
		expect(run).not.toHaveBeenCalled();
		wire.set("open");
		wire.set("open");
		expect(run).toHaveBeenCalledTimes(1);
		expect(wire.listening()).toBe(0);
	});

	it("runs nothing after it was cancelled", () => {
		const run = vi.fn();
		const wire = link("connecting");
		whenLinkOpen(wire.runtime, run)();
		wire.set("open");
		expect(run).not.toHaveBeenCalled();
		expect(wire.listening()).toBe(0);
	});
});
