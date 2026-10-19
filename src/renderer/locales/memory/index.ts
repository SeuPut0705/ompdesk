/** Every string of Settings › Memory (the page, the side panel's Memory view, the palette entry), one file per section. */
import * as handoffs from "./handoffs";
import * as maintenance from "./maintenance";
import * as overview from "./overview";
import * as pages from "./pages";
import * as profile from "./profile";
import * as search from "./search";
import * as sessions from "./sessions";
import * as shell from "./shell";

const parts = [shell, overview, search, pages, handoffs, sessions, profile, maintenance];
export const memoryEn: Record<string, string> = Object.assign({}, ...parts.map(part => part.en));
export const memoryKo: Record<string, string> = Object.assign({}, ...parts.map(part => part.ko));
