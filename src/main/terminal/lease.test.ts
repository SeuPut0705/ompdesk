/** The PTY size lease between the desktop and a phone (design S11): who may resize, and when it moves. */
import { describe, expect, it } from "vitest";
import { HOLDER_IDLE_MS, PRESENCE_MS, TerminalLease } from "./lease";

const DESKTOP = 3;
const PHONE = -1;
const TERM = "3:tab|pty";

function setup() {
	let now = 1_000_000;
	const lease = new TerminalLease({ now: () => now });
	return {
		lease,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("TerminalLease", () => {
	it("lets a lone viewer resize as it always did, and a second one watch", () => {
		const { lease } = setup();
		expect(lease.seen(TERM, DESKTOP)).toBe("free");
		expect(lease.mayResize(TERM, DESKTOP)).toBe(true);
		expect(lease.seen(TERM, DESKTOP)).toBe("you");
		expect(lease.seen(TERM, PHONE)).toBe("other");
		expect(lease.mayResize(TERM, PHONE)).toBe(false);
		expect(lease.mayResize(TERM, DESKTOP)).toBe(true);
	});

	it("moves to the phone when it claims, and back when the desktop does", () => {
		const { lease } = setup();
		lease.mayResize(TERM, DESKTOP);
		lease.seen(TERM, PHONE);
		lease.claim(TERM, PHONE);
		expect(lease.state(TERM, PHONE)).toBe("you");
		expect(lease.state(TERM, DESKTOP)).toBe("other");
		expect(lease.mayResize(TERM, DESKTOP)).toBe(false);
		lease.claim(TERM, DESKTOP);
		expect(lease.state(TERM, DESKTOP)).toBe("you");
		expect(lease.state(TERM, PHONE)).toBe("other");
	});

	it("lets go of a holder that stopped asking, so the next resize takes it", () => {
		const { lease, advance } = setup();
		lease.mayResize(TERM, DESKTOP);
		lease.seen(TERM, PHONE);
		expect(lease.state(TERM, PHONE)).toBe("other");
		advance(PRESENCE_MS + 1);
		lease.seen(TERM, PHONE);
		expect(lease.state(TERM, PHONE)).toBe("free");
		expect(lease.mayResize(TERM, PHONE)).toBe(true);
		expect(lease.state(TERM, PHONE)).toBe("you");
	});

	it("keeps a holder that keeps asking, even without typing", () => {
		const { lease, advance } = setup();
		lease.mayResize(TERM, DESKTOP);
		for (let tick = 0; tick < 8; tick++) {
			advance(PRESENCE_MS / 2);
			lease.seen(TERM, DESKTOP);
		}
		lease.seen(TERM, PHONE);
		expect(lease.state(TERM, PHONE)).toBe("other");
	});

	it("moves to a typist only after the holder has been idle, so two people typing in turn never fight", () => {
		const { lease, advance } = setup();
		lease.mayResize(TERM, DESKTOP);
		lease.seen(TERM, PHONE);
		lease.typed(TERM, DESKTOP);
		advance(2000);
		lease.seen(TERM, DESKTOP);
		lease.typed(TERM, PHONE);
		expect(lease.state(TERM, DESKTOP)).toBe("you");
		advance(HOLDER_IDLE_MS);
		lease.seen(TERM, DESKTOP);
		lease.typed(TERM, PHONE);
		expect(lease.state(TERM, PHONE)).toBe("you");
		expect(lease.state(TERM, DESKTOP)).toBe("other");
	});

	it("a typist takes a lease nobody holds", () => {
		const { lease } = setup();
		lease.typed(TERM, PHONE);
		expect(lease.state(TERM, PHONE)).toBe("you");
	});

	it("forgets a closed terminal and every terminal of a released tab", () => {
		const { lease } = setup();
		lease.claim(TERM, DESKTOP);
		lease.claim("3:tab|other", DESKTOP);
		lease.claim("3:else|pty", DESKTOP);
		lease.forget(TERM);
		expect(lease.state(TERM, DESKTOP)).toBe("free");
		lease.forgetOwner("3:tab|");
		expect(lease.state("3:tab|other", DESKTOP)).toBe("free");
		expect(lease.state("3:else|pty", DESKTOP)).toBe("you");
	});
});
