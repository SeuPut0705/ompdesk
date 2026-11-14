/** Makes `process.platform` what `OMP_CAPTURE_PLATFORM` says before any module reads it (`bun --preload`). */
const platform = process.env.OMP_CAPTURE_PLATFORM;
if (platform) Object.defineProperty(process, "platform", { value: platform });
