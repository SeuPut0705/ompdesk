/**
 * The agent's `gui_visualize` host tool as omp registers it. The tool itself runs in the shell's `preview` module
 * (`native/ompdesk/crates/shell/src/modules/preview/visualize.rs`, PROTOCOL.md §15.6); this file is the one thing
 * about it Node still owns: the definition the lane hands stock (`sidecar.ts`), so its wording and bounds change
 * here and in the module's argument rules together.
 */
import type { HostToolDefinition } from "../../shared/rpc-types";

export const VISUALIZE_TOOL = "gui_visualize";
const CHOICE_DEFAULT_SECONDS = 120;
const CHOICE_MAX_SECONDS = 600;

export const VISUALIZE_DEFINITION: HostToolDefinition = {
	name: VISUALIZE_TOOL,
	label: "Visualize",
	description:
		"Show the user a page, SVG or image in OMPdesk's Preview panel beside the chat.\n" +
		"Show the user a page, SVG or image you made, or a web page, in OMPdesk's Preview panel beside the chat, and keep each change as a version they can flip through. " +
		"open: show `target` (a .html/.svg/image file inside the working directory, or an http(s) URL) or `html` (a complete HTML document you write); opening the same file, URL or visual id again adds a version. " +
		"The user can comment on elements or regions of the page and tweak its CSS variables; that feedback arrives as their next message. " +
		"check: the shown page's title and console errors. choose: wait for the user to click an element with a data-choice attribute in the page and return its value (use it to let them pick between options you drew). close: remove a visual.",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["open", "check", "choose", "close"] },
			target: { type: "string", description: "open: file path (relative to the working directory) or http(s) URL." },
			html: { type: "string", description: "open: a complete HTML document instead of target." },
			label: { type: "string", description: "open: tab title; default the file name or page title." },
			visual: { type: "string", description: "Visual id from an earlier open (required for check, choose, close)." },
			timeout_seconds: {
				type: "integer",
				minimum: 10,
				maximum: CHOICE_MAX_SECONDS,
				description: `choose: how long to wait; default ${CHOICE_DEFAULT_SECONDS}.`,
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
};
