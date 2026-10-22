/**
 * The color a device section's header row wears in the sidebar, so a paired host's rows are told from this computer's
 * at a glance (the user's request, 22 Oct 2026). Each host gets one by itself from its id; the header's gear sets
 * another, or none. This computer's own header has none unless chosen. The hues are drawn per theme in
 * components.css (`[data-device-color]`), never a status color, so no device reads as an error or a warning.
 */
export const DEVICE_COLORS = ["blue", "teal", "violet", "amber", "pink", "green"] as const;

export type DeviceColor = (typeof DEVICE_COLORS)[number];

/** What the person chose for a device: a color, or `none`. Absent means automatic. */
export type DeviceColorChoice = DeviceColor | "none";

export function isDeviceColorChoice(value: unknown): value is DeviceColorChoice {
	return value === "none" || DEVICE_COLORS.includes(value as DeviceColor);
}

/** A host's own color when nobody chose one: the same for an id on every launch and every computer. */
export function autoDeviceColor(deviceId: string): DeviceColor {
	let hash = 0;
	for (const char of deviceId) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
	return DEVICE_COLORS[hash % DEVICE_COLORS.length] ?? "blue";
}

/** The color a header wears: the choice, else automatic for a host and none for this computer. */
export function deviceColorOf(
	deviceId: string,
	choice: DeviceColorChoice | undefined,
	local: boolean,
): DeviceColor | null {
	if (choice === "none") return null;
	if (choice) return choice;
	return local ? null : autoDeviceColor(deviceId);
}
