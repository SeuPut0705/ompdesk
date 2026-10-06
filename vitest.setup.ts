if (typeof navigator !== "undefined") {
	Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
}
