/**
 * The channel `ompdesk_app`'s `checks.publish_admission_key` calls (`src/main/checks/admission-key.ts`). Main only:
 * the renderer never sends it, so it stays out of `IPC_COMMANDS` and the phone's first screen.
 */
export const CHECKS_PUBLISH_ADMISSION_KEY = "checks:publish-admission-key";
