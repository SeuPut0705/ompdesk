import type { OmpApi } from "../shared/ipc-types";

declare global {
	interface Window {
		omp: OmpApi;
	}
}
