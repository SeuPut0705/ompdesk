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

export type SafeStorageFact =
	| { kind: "win-v10"; key: string }
	| { kind: "mac-v10"; password: string }
	| { unavailable: string };

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
