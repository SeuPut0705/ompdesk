/** The values the shell hands over in the answer to `hello` (PROTOCOL.md §1) and the shapes the protocol shares. */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DisplayFact {
	id: number;
	label: string;
	bounds: Rect;
	workArea: Rect;
	scaleFactor: number;
	rotation: 0 | 90 | 180 | 270;
	internal: boolean;
	colorDepth: number;
	monitorFrequency?: number;
}

/** The key as the shell read it: handed over in the facts (Windows), or by `--keychain-key` (macOS, `SafeStorageKey`). */
export type SafeStorageKey =
	| { kind: "win-v10"; key: string }
	| { kind: "mac-v10"; password: string }
	| { unavailable: string };

/** What `facts.safeStorage` is: a key, or on macOS the promise to fetch it on first use (the keychain asks the person). */
export type SafeStorageFact = SafeStorageKey | { kind: "mac-v10-lazy" };

export const PATH_NAMES = [
	"userData",
	"appData",
	"sessionData",
	"home",
	"temp",
	"exe",
	"module",
	"desktop",
	"documents",
	"downloads",
	"music",
	"pictures",
	"videos",
	"logs",
	"crashDumps",
] as const;
export type PathName = (typeof PATH_NAMES)[number];

export interface HostFacts {
	paths: Record<PathName, string>;
	exe: string;
	resourcesPath: string;
	appPath: string;
	isPackaged: boolean;
	/** The renderer folder the shell serves as `app://ompdesk/` (the running bundle's `../renderer`); absent: `<appPath>/out/renderer`. */
	rendererRoot?: string;
	argv: string[];
	locale: { appLocale: string; systemLocale: string; preferredLanguages: string[] };
	displays: DisplayFact[];
	primaryDisplayId: number;
	theme: { dark: boolean; highContrast: boolean; inverted: boolean };
	system: { reducedMotion: boolean; onBattery: boolean; online: boolean };
	versions: { chrome: string; cef: string; shell: string };
	safeStorage: SafeStorageFact;
}

export interface WinState {
	bounds: Rect;
	normalBounds: Rect;
	contentBounds: Rect;
	visible: boolean;
	focused: boolean;
	minimized: boolean;
	maximized: boolean;
	fullscreen: boolean;
	title: string;
	opacity: number;
}

export interface WcState {
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	zoomFactor: number;
	audioMuted: boolean;
	devtoolsOpened: boolean;
	crashed: boolean;
	userAgent: string;
	frameRate?: number;
}

export interface SchemeFact {
	scheme: string;
	privileges: {
		standard?: boolean;
		secure?: boolean;
		bypassCSP?: boolean;
		allowServiceWorkers?: boolean;
		supportFetchAPI?: boolean;
		corsEnabled?: boolean;
		stream?: boolean;
		codeCache?: boolean;
	};
}
