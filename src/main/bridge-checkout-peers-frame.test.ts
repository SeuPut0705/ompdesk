/**
 * gui-bridge modes/checkout-peers.ts, the work board's side: what main pushes (`checkout_peers_set`) tells the GUI
 * (`checkout_peers` frame, answered by `checkout_peers.get`) only when what the session knows changes. The state is
 * checkout-peers-core.ts's `CheckoutPeersState`; the bridge method emits the frame when `set` says it changed.
 */
import { describe, expect, it } from "vitest";
import { CHECKOUT_PEERS_EVENT } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { CheckoutPeersState } from "../../resources/gui-bridge/modes/checkout-peers-core";

const payload = (worktree: unknown[], repo: unknown[] = []) => ({
	toplevel: "/work/app",
	commonDir: "/work/app/.git",
	worktree,
	repo,
	canMessage: true,
});

const company = { id: "tab-b", title: "Rename helper" };

/** The bridge method's body: the frame it would emit for one push. */
function push(state: CheckoutPeersState, params: unknown): unknown[] {
	return state.set(params) ? [{ type: CHECKOUT_PEERS_EVENT, peers: state.peers ?? null }] : [];
}

describe("checkout_peers frame", () => {
	it("pushes the peers when company arrives, nothing for an unchanged push, and null when the session is alone again", () => {
		const state = new CheckoutPeersState();
		expect(state.peers).toBeUndefined();

		expect(push(state, payload([company]))).toEqual([
			{
				type: CHECKOUT_PEERS_EVENT,
				peers: {
					toplevel: "/work/app",
					commonDir: "/work/app/.git",
					worktree: [company],
					repo: [],
					canMessage: true,
				},
			},
		]);
		expect(push(state, payload([company]))).toEqual([]);
		expect(state.peers?.worktree).toEqual([company]);

		expect(push(state, payload([]))).toEqual([{ type: CHECKOUT_PEERS_EVENT, peers: null }]);
		expect(state.peers).toBeUndefined();
	});

	it("tells nothing to a session that starts alone", () => {
		expect(push(new CheckoutPeersState(), payload([]))).toEqual([]);
	});

	it("tells the GUI when a peer's title changes, and keeps a hidden session as a peer without id or title", () => {
		const state = new CheckoutPeersState();
		push(state, payload([], [{ id: null, title: "Secret", worktree: "/wt/x" }]));
		expect(state.peers?.repo).toEqual([{ id: null, title: "Secret", worktree: "/wt/x" }]);
		expect(push(state, payload([], [{ id: null, title: "Renamed", worktree: "/wt/x" }]))).toHaveLength(1);
	});

	it("refuses a push that is not the checkout's peers", () => {
		expect(() => new CheckoutPeersState().set({ worktree: [] })).toThrow("checkout_peers_set");
	});
});
