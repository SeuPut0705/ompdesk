/** Every string of check control (the sidebar block, the Checks page, the work board's row), one file per surface. */
import * as page from "./page";
import * as sidebar from "./sidebar";
import * as tests from "./tests";

const parts = [page, sidebar, tests];
export const checksEn: Record<string, string> = Object.assign({}, ...parts.map(part => part.en));
export const checksKo: Record<string, string> = Object.assign({}, ...parts.map(part => part.ko));
