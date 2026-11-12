/**
 * Where and how the shipped ai-memory is staged, in a module without the core client, so the packaged e2e can import it
 * outside Electron.
 */
import macSigning from "../../../scripts/mac-signing.json" with { type: "json" };

/**
 * macOS: the designated requirement of the shipped binary of a packaged build. Packaging re-signs it
 * (`scripts/mac-sign.cjs`) after `scripts/after-pack.cjs` held its bytes to the build record, so what names it
 * afterwards is this requirement: codesign identifies an unbundled Mach-O by its file name, and every release is signed
 * with OMPdesk's pinned certificate (`scripts/mac-signing.json`). Any other signature, ad-hoc or not, fails it.
 */
export const AI_MEMORY_REQUIREMENT = `identifier "ai-memory" and certificate root = H"${macSigning.certificateSha1}"`;
/** macOS: the one folder under `<tools>/ai-memory` every build stages into, so TCC's grants (keyed by path) survive. */
export const MAC_STAGE_KEY = "current";
