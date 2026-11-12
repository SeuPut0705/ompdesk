/**
 * What the macOS bundle of the CEF shell is made of, in one place: `scripts/package-mac.ts` writes it and
 * `scripts/after-pack.cjs` holds the finished bundle to it (CommonJS so both can read it).
 *
 * `OMPdesk.app` (bundle id `com.seuput.ompdesk`, the identity the updater's `stageBundleFromDmg` checks and the pinned
 * certificate's designated requirement names):
 *
 *   Contents/MacOS/OMPdesk                                the shell (`ompdesk-shell`, renamed)
 *   Contents/Frameworks/Chromium Embedded Framework.framework
 *   Contents/Frameworks/OMPdesk Helper[ (GPU| (Renderer)| (Plugin)| (Alerts))].app   each a copy of the shell
 *   Contents/Resources/{node, app/out, gui-bridge, ompdesk-bin, ai-memory-bin, agent-desktop-bin, …}
 *
 * CEF finds its helper processes by these names (the prototype's `bundle-mac.sh`, native/shell-prototype/cef).
 */

const APP_ID = "com.seuput.ompdesk";
const PRODUCT = "OMPdesk";
const FRAMEWORK = "Chromium Embedded Framework.framework";

/** CEF's five helper kinds: the suffix of the app's name and of its bundle id. */
const HELPERS = [
	{ suffix: "", id: "helper" },
	{ suffix: " (GPU)", id: "helper.GPU" },
	{ suffix: " (Renderer)", id: "helper.Renderer" },
	{ suffix: " (Plugin)", id: "helper.Plugin" },
	{ suffix: " (Alerts)", id: "helper.Alerts" },
];

/** The prompts the bundle can trigger, each naming the app (Chromium's own default names none). */
const PRIVACY = {
	NSMicrophoneUsageDescription: "OMPdesk uses the microphone for voice dictation in the composer.",
	NSCameraUsageDescription: "OMPdesk does not use the camera.",
	NSBluetoothAlwaysUsageDescription: "OMPdesk does not use Bluetooth.",
	NSBluetoothPeripheralUsageDescription: "OMPdesk does not use Bluetooth.",
};

/**
 * Two origins only: the loopback stats server and GitHub releases over TLS. Declaring that is stricter than the
 * default, so an accidental remote cleartext request cannot start working because some build set
 * NSAllowsArbitraryLoads.
 */
const TRANSPORT = { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true };

/** The app's Info.plist as a plain object (`plist.build` writes it). */
function appInfo(version) {
	return {
		CFBundleDevelopmentRegion: "en",
		CFBundleExecutable: PRODUCT,
		CFBundleIconFile: "icon.icns",
		CFBundleIdentifier: APP_ID,
		CFBundleInfoDictionaryVersion: "6.0",
		CFBundleName: PRODUCT,
		CFBundleDisplayName: PRODUCT,
		CFBundlePackageType: "APPL",
		CFBundleShortVersionString: version,
		CFBundleVersion: version,
		// `omp://` deep links only reach the app if LaunchServices sees CFBundleURLTypes, which this is the only
		// thing that writes (the shell routes the Apple Event as `app.openUrl`).
		CFBundleURLTypes: [{ CFBundleURLName: APP_ID, CFBundleURLSchemes: ["omp"] }],
		LSApplicationCategoryType: "public.app-category.developer-tools",
		LSMinimumSystemVersion: "12.0",
		// CEF's NSApplication subclass (shared/mac_app.rs) is installed before anything touches NSApp.
		NSPrincipalClass: "NSApplication",
		NSHighResolutionCapable: true,
		NSSupportsAutomaticGraphicsSwitching: true,
		LSEnvironment: { MallocNanoZone: "0" },
		...PRIVACY,
		NSAppTransportSecurity: { ...TRANSPORT },
	};
}

/** A helper app's Info.plist: no Dock icon, its own bundle id under the app's. */
function helperInfo(version, helper) {
	const name = `${PRODUCT} Helper${helper.suffix}`;
	return {
		CFBundleDevelopmentRegion: "en",
		CFBundleExecutable: name,
		CFBundleIdentifier: `${APP_ID}.${helper.id}`,
		CFBundleInfoDictionaryVersion: "6.0",
		CFBundleName: name,
		CFBundleDisplayName: name,
		CFBundlePackageType: "APPL",
		CFBundleShortVersionString: version,
		CFBundleVersion: version,
		LSMinimumSystemVersion: "12.0",
		LSUIElement: true,
		NSHighResolutionCapable: true,
		NSSupportsAutomaticGraphicsSwitching: true,
		LSEnvironment: { MallocNanoZone: "0" },
	};
}

module.exports = { APP_ID, PRODUCT, FRAMEWORK, HELPERS, PRIVACY, TRANSPORT, appInfo, helperInfo };
