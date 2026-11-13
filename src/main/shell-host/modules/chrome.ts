/**
 * Node's client of the shell's `chrome` module (PROTOCOL.md §15.5, batch SX1): the app windows, the application menu,
 * the tray, the quit, deep links, the GPU fallback and the main-thread watchdog. The wire is declared per area in
 * `chrome-<area>.ts`, which also exports what the rest of main calls; this file joins the areas into one namespace.
 */
import type { HostClient } from "../electron/host";
import type { DeepLinkSpec } from "./chrome-deep-link";
import type { GpuSpec } from "./chrome-gpu";
import type { HangSpec } from "./chrome-hang";
import type { MenuSpec } from "./chrome-menu";
import type { QuitSpec } from "./chrome-quit";
import type { TraySpec } from "./chrome-tray";
import type { WindowSpec } from "./chrome-window";
import { type ModuleClient, type ModuleSpec, shellHost, shellModule } from "./client";

type Areas = [WindowSpec, MenuSpec, TraySpec, QuitSpec, DeepLinkSpec, GpuSpec, HangSpec];
type Join<K extends keyof ModuleSpec> = Areas[number] extends infer A
	? (A extends ModuleSpec ? (x: A[K]) => void : never) extends (x: infer I) => void
		? I
		: never
	: never;

export interface ChromeSpec extends ModuleSpec {
	calls: Join<"calls">;
	posts: Join<"posts">;
	events: Join<"events">;
	asks: Join<"asks">;
}

let client: ModuleClient<ChromeSpec> = shellModule<ChromeSpec>("chrome");

/** The `chrome` namespace's client: every area file speaks through it. */
export function chrome(): ModuleClient<ChromeSpec> {
	return client;
}

/** A parity suite points the areas at its own shell (`startTestShell`); main never calls this. */
export function pointChromeAt(host: () => HostClient = shellHost): void {
	client = shellModule<ChromeSpec>("chrome", host);
}
