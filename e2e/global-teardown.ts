import { clearRunTemp, RUN_TEMP_ENV } from "./run-temp";

// Runs once, after every worker: whatever is left in this run's temp folder (a crashed worker's profiles, an app or
// fake it left running) goes with the folder (e2e/run-temp.ts).
export default function globalTeardown(): void {
	const dir = process.env[RUN_TEMP_ENV];
	if (dir) clearRunTemp(dir);
}
