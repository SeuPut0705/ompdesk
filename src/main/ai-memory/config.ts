/**
 * ai-memory's default retrieval adds in-process sentence embeddings (all-MiniLM-L6-v2): an 87 MB model fetched once from
 * huggingface.co, ~220 MB more resident memory in the always-on server (measured on 3.1.1: 136 MB without, 355 MB
 * with) and the model's disk. OMPdesk's fresh install opts out with ai-memory's own documented setting
 * (`embedding_provider = "none"`: full-text, entity and graph search, no download, nothing leaves the machine). The
 * user can still turn hybrid search on by editing the line in config.toml; an existing config is never touched.
 */
const OPT_OUT_LINE = /^#[ \t]+embedding_provider[ \t]*=[ \t]*"none"[^\n]*$/m;
const ACTIVE_LINE = /^[ \t]*embedding_provider[ \t]*=/m;

export const EMBEDDINGS_NOTE =
	"# OMPdesk: no local embedding model (no download, ~220 MB less memory). Remove this line for hybrid search.";

/** `config.toml` with `embedding_provider = "none"` switched on, or null when it has the setting already or no template line. */
export function withoutLocalEmbeddings(toml: string): string | null {
	if (ACTIVE_LINE.test(toml) || !OPT_OUT_LINE.test(toml)) return null;
	return toml.replace(OPT_OUT_LINE, `embedding_provider = "none"  ${EMBEDDINGS_NOTE}`);
}
