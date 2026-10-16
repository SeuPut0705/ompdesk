/**
 * Stock's code-paste prompt beside an OAuth callback (pi-ai `auth/oauth.ts`
 * `login`, `cli/oauth-terminal.ts`). The bridge's MCP sign-in asks with the
 * same words, and the renderer recognizes them to present the paste as an
 * optional sign-in step. Dependency-free, so the renderer and the packaged
 * bridge share it.
 */
export const OAUTH_PASTE_PROMPT = "Paste the authorization code (or full redirect URL):";
