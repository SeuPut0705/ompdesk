/**
 * `?checks=busy|idle`: a frame for the check-control screens, as main's relay would send it. The snapshot is the
 * hub fake's own (`sampleSnapshot`, src/shared/checks-fixture.ts: GitHub's macOS pool full with a queue, this
 * computer, a paired one that is offline, a release with two gates, three runs) under made-up names for its ids.
 * `idle` is a hub with nothing to run, where the sidebar block draws nothing.
 */

import { emptySnapshot } from "../../shared/checks-contract";
import { sampleSnapshot } from "../../shared/checks-fixture";
import type { ChecksFrame } from "../../shared/checks-frame";
import { sampleNames } from "../../shared/checks-frame-fixture";

const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
export const CHECKS_FIXTURE = query.get("checks");

export { sampleNames };

export function checksFrame(kind: "busy" | "idle", now = Date.now(), ko = query.get("lang") === "ko"): ChecksFrame {
	return {
		snapshot: kind === "busy" ? sampleSnapshot(now) : emptySnapshot(now),
		names: sampleNames(ko),
		hub: "live",
	};
}
