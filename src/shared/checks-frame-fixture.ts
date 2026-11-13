/** Made-up names for the ids of `sampleSnapshot` (`checks-fixture.ts`): what a relay with a scripted hub sends. */
import type { ChecksNames } from "./checks-frame";

export function sampleNames(ko = false): ChecksNames {
	return {
		devices: { local: { name: "MacBook", here: true }, "mac-mini": { name: "Mac mini" } },
		sessions: {
			"0a1b2c3d": { title: ko ? "1.4 출시 (오토파일럿)" : "Ship 1.4 (Autopilot)", autopilot: true },
			"4e5f6a7b": { title: ko ? "검색 색인" : "Search index" },
		},
	};
}
