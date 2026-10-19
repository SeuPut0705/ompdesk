import { assertAppBuilt } from "../scripts/e2e-app-entry";

// Runs once, before any worker: a missing build fails the whole run here instead of letting every test's
// Electron launch show a native "Unable to find Electron app" dialog (scripts/e2e-app-entry.ts).
export default function globalSetup(): void {
	assertAppBuilt();
}
