import * as os from "node:os";
import * as path from "node:path";

/** Keep desktop config and session discovery on the same Agent profile. */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
}
