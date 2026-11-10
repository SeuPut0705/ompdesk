/** What the fake omp's `fixture narrated` reply says to the person beside its tool call (e2e/fixture/rpc-ui.ts). */
export const NARRATION_TEXT =
	"Here is the plan before I start: run the test suite first, then fix whatever fails and tell you what changed.";

/** The steer the fake omp's `fixture steered` turn takes in between its two calls (e2e/fixture/rpc-ui.ts). */
export const STEER_TEXT = "Also check how long the CI run takes.";

/**
 * How the reply after that steer answers it: the way the owner's agent did (omp 18.18.6, 10 Nov 2026), as a narration
 * thinking block (pi-ai `ThinkingContent.narration`) beside plain reasoning and its call, with no text block.
 */
export const STEER_ANSWER = "Yes, I will time the CI run too, right after the tests.";
export const STEER_REASONING = "The person also wants the CI run timed.";
