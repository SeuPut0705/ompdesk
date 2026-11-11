/**
 * Where OMPdesk's own native binaries are (`native/ompdesk`, staged by `bun run build:native`): the packaged app's
 * `Resources/ompdesk-bin/`, else this checkout's `resources/ompdesk-bin/<platform>-<arch>/`. The checkout path is the
 * default (from `src/main` under vitest and from `out/main` in a dev run both are two levels below the root), so a
 * test needs no configuration; `index.ts` configures the packaged app.
 */
import { join } from "node:path";

export type NativeBinary = "ompdesk" | "ompdesk-core";

let location = { packaged: false, resourcesPath: join(__dirname, "..", "..", "resources") };

export function configureNativeBin(options: { packaged: boolean; resourcesPath: string }): void {
	location = { ...options };
}

export function nativeBinPath(name: NativeBinary): string {
	const file = process.platform === "win32" ? `${name}.exe` : name;
	return location.packaged
		? join(location.resourcesPath, "ompdesk-bin", file)
		: join(location.resourcesPath, "ompdesk-bin", `${process.platform}-${process.arch}`, file);
}
