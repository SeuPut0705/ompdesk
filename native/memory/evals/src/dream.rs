//! `dream` — the B2 dream pass on vs off, measured on a copy of a real store.
//!
//! The store under `--source` is snapshotted into a temp dir (`VACUUM INTO`
//! for the database, a file copy for the wiki) and never written. Every
//! decayable page of the copy is then treated as cold (a `cold_threshold` no
//! retention reaches), which is what the store looks like once it has aged
//! past the default decay. On that copy:
//!
//! 1. A fixed question set is built BEFORE anything changes: one question per
//!    page, its `--terms` highest TF-IDF terms within its project (a
//!    known-item query, the page being the answer).
//! 2. Every question runs through the zero-embedder `memory_query` search
//!    (`hybrid_search` without a vector: FTS + entity + graph fused); the
//!    ranked paths are kept.
//! 3. The dream pass runs per project with its real scheduler config, through
//!    omp's `pi/smol` role (real model calls, bounded by `--max-clusters`).
//! 4. The questions run again. A question counts as answered when any page of
//!    its answer's merge group ranks within k, before and after alike, so the
//!    delta is what the merge did to finding that information, not a change
//!    of the answer key.
//! 5. Every durable fact (keep-token) of every merged source is checked in the
//!    rewritten survivor, and searched for on its own.
//!
//! With `--dry-run` only the plan and the distance profile are reported: no
//! model call, no write.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use ai_memory_consolidate::{
    DreamCancel, DreamConfig, DreamReport, DreamVectors, EmbeddingCoord, adaptive_eps,
    cosine_distance, dbscan, lexical_terms, lexical_vectors, mine_keep_tokens, run_dream_pass,
};
use ai_memory_core::{PageId, PagePath, Tier};
use ai_memory_llm::{Embedder, OMP_DEFAULT_MODEL, OmpProvider, OmpUsage};
use ai_memory_store::{DecayParams, ReaderPool, Store};
use ai_memory_wiki::Wiki;
use anyhow::{Context, Result, bail};
use serde::Serialize;

#[derive(clap::Args, Debug)]
pub struct DreamArgs {
    /// ai-memory data dir to measure (holds `db/` and `wiki/`). Snapshotted
    /// into a temp dir first; never written.
    #[arg(long)]
    source: PathBuf,
    /// omp executable the merges run through (its `pi/smol` role).
    #[arg(long, default_value = "omp")]
    omp: PathBuf,
    /// Only these projects (repeatable). Default: every project.
    #[arg(long = "project")]
    projects: Vec<String>,
    /// Clusters merged per project: the pass's own per-run bound.
    #[arg(long, default_value_t = ai_memory_consolidate::DEFAULT_DREAM_MAX_CLUSTERS_PER_RUN)]
    max_clusters: usize,
    /// Cosine-distance ceiling for clustering. 0 = the pass default.
    #[arg(long, default_value_t = 0.0)]
    max_eps: f32,
    /// Query terms per question.
    #[arg(long, default_value_t = 5)]
    terms: usize,
    /// What dream clusters by: the pages' terms (no embedder, OMPdesk's
    /// setting) or the server's default local embedder.
    #[arg(long, value_enum, default_value_t = Vectors::Lexical)]
    embedder: Vectors,
    /// Folder holding (or receiving) the local embedder's model.
    #[arg(long)]
    models: Option<PathBuf>,
    /// Plan only: clusters and the distance profile, no model call, no write.
    #[arg(long)]
    dry_run: bool,
    /// Directory for report.json. Default `evals/runs/<timestamp>-dream/`.
    #[arg(long)]
    out: Option<PathBuf>,
}

const K_RECALL: usize = 5;
const K_MRR: usize = 10;
/// Distances at which the profile counts clusters (DBSCAN, min_pts 2).
const PROFILE_EPS: [f32; 6] = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30];

/// `--embedder`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
enum Vectors {
    /// TF-IDF term vectors of the pages' own text.
    Lexical,
    /// all-MiniLM-L6-v2, in process.
    Local,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
enum Slice {
    /// A cold page that ended up in an applied merge.
    Merged,
    /// A cold page dream left alone.
    ColdUnmerged,
    /// A page outside the cold set (semantic tier, pinned): collateral only.
    Durable,
}

struct Question {
    project: String,
    path: String,
    cold: bool,
    query: String,
    before: Vec<String>,
}

#[derive(Serialize, Default, Clone, Copy)]
struct Score {
    questions: usize,
    recall_at_5: f64,
    mrr_at_10: f64,
}

#[derive(Serialize)]
struct SliceScore {
    slice: Slice,
    before: Score,
    after: Score,
}

#[derive(Serialize, Default)]
struct Facts {
    /// Keep-tokens across every merged source.
    total: usize,
    /// Present in the rewritten survivor.
    kept: usize,
    /// Found by searching for the token alone, survivor within the top 10.
    findable: usize,
    /// Keep-tokens of the rewrite found in no source (invented).
    invented: usize,
    /// Every lost token, `survivor: token`, for reading.
    lost: Vec<String>,
}

#[derive(Serialize)]
struct Profile {
    project: String,
    cold_pages: usize,
    /// Nearest-neighbour cosine distance percentiles (p10, p25, p50).
    nn_distance: [f32; 3],
    /// The pass's own adaptive eps at the default ceiling.
    adaptive_eps: Option<f32>,
    /// (eps, clusters, pages in clusters).
    clusters_at: Vec<(f32, usize, usize)>,
}

#[derive(Serialize)]
struct Report {
    source: String,
    model_role: &'static str,
    vectors: Vectors,
    dry_run: bool,
    max_clusters_per_project: usize,
    projects: usize,
    pages: usize,
    cold_pages: usize,
    dream: Vec<(String, DreamReport)>,
    dream_wall_ms: u128,
    llm: OmpUsage,
    profiles: Vec<Profile>,
    scores: Vec<SliceScore>,
    facts: Facts,
}

pub async fn run(args: DreamArgs) -> Result<()> {
    let tmp = tempfile::TempDir::new()?;
    snapshot(&args.source, tmp.path())?;
    let store = Store::open(tmp.path()).context("open the snapshot")?;
    let wiki = Wiki::new(tmp.path(), store.writer.clone())?.with_store_reader(store.reader.clone());
    let reader = &store.reader;

    let mut scopes = reader.list_all_scopes().await?;
    if !args.projects.is_empty() {
        scopes.retain(|s| args.projects.contains(&s.project_name));
    }
    if scopes.is_empty() {
        bail!("no project to measure");
    }
    let embedder = match args.embedder {
        Vectors::Lexical => None,
        Vectors::Local => Some(local_embedder(&args, tmp.path(), &store, &wiki, &scopes).await?),
    };
    let params = DecayParams {
        // Every decayable page is cold: the store as it reads once aged.
        cold_threshold: f64::MAX,
        ..DecayParams::default()
    };
    let cfg = DreamConfig {
        enabled: true,
        vectors: embedder
            .as_ref()
            .map_or(DreamVectors::Lexical, |e| DreamVectors::Stored(coord(e))),
        max_eps: args.max_eps,
        max_clusters_per_run: args.max_clusters,
        ..DreamConfig::default()
    };
    let llm = OmpProvider::new(
        args.omp.clone(),
        OMP_DEFAULT_MODEL,
        std::env::temp_dir(),
        &std::env::vars_os().collect::<Vec<_>>(),
    );

    let mut questions: Vec<Question> = Vec::new();
    let mut bodies: HashMap<(String, String), String> = HashMap::new();
    let mut profiles = Vec::new();
    let mut pages = 0;
    let mut cold_pages = 0;
    for scope in &scopes {
        let (ws, proj) = (scope.workspace_id, scope.project_id);
        let candidates = reader.decay_candidates(ws, proj).await?;
        let mut ids: Vec<PageId> = Vec::new();
        let mut docs: Vec<(String, String, bool)> = Vec::new();
        for c in &candidates {
            if c.expires_at_us.is_some_and(|t| t <= now_us()) {
                continue;
            }
            let Ok(md) = wiki.read_page(ws, proj, &c.path) else {
                continue;
            };
            let cold = c.tier == Tier::Episodic && !c.pinned && c.compacted_at_us.is_none();
            ids.push(c.id);
            docs.push((c.path.as_str().to_string(), md.body, cold));
        }
        pages += docs.len();
        cold_pages += docs.iter().filter(|d| d.2).count();
        let cold_vectors: Vec<Vec<f32>> = match &embedder {
            None => {
                let texts: Vec<&str> = docs.iter().map(|d| d.1.as_str()).collect();
                lexical_vectors(&texts)
                    .into_iter()
                    .zip(&docs)
                    .filter(|(_, d)| d.2)
                    .map(|(v, _)| v)
                    .collect()
            }
            Some(e) => {
                let c = coord(e);
                let stored: HashMap<PageId, Vec<f32>> = reader
                    .load_embeddings(ws, proj, c.provider, c.model, c.dim)
                    .await?
                    .into_iter()
                    .map(|row| (row.id, row.vector))
                    .collect();
                ids.iter()
                    .zip(&docs)
                    .filter(|(_, d)| d.2)
                    .filter_map(|(id, _)| stored.get(id).cloned())
                    .collect()
            }
        };
        profiles.push(profile(
            &scope.project_name,
            &cold_vectors,
            ceiling(args.max_eps),
        ));
        for (path, query) in known_item_queries(&docs, args.terms) {
            let cold = docs.iter().any(|d| d.0 == path && d.2);
            let before = search(reader, embedder.as_ref(), ws, proj, &query).await?;
            questions.push(Question {
                project: scope.project_name.clone(),
                path,
                cold,
                query,
                before,
            });
        }
        for (path, body, _) in docs {
            bodies.insert((scope.project_name.clone(), path), body);
        }
    }

    let started = Instant::now();
    let mut dream = Vec::new();
    for scope in &scopes {
        let report = run_dream_pass(
            reader,
            &wiki,
            Some(&llm),
            scope.workspace_id,
            scope.project_id,
            &params,
            0.0,
            &cfg,
            &DreamCancel::new(),
            args.dry_run,
        )
        .await?;
        tracing::info!(
            project = %scope.project_name,
            considered = report.clusters_considered,
            merged = report.clusters_merged,
            skipped = report.skipped,
            "dream pass"
        );
        dream.push((scope.project_name.clone(), report));
    }
    let dream_wall_ms = started.elapsed().as_millis();

    // Merge groups: every member of an applied merge answers for every other.
    let mut group: HashMap<(String, String), Vec<String>> = HashMap::new();
    for (project, report) in &dream {
        for merge in report.merges.iter().filter(|m| m.applied) {
            let mut members = vec![merge.survivor.clone()];
            members.extend(merge.merged.iter().cloned());
            for member in &members {
                group.insert((project.clone(), member.clone()), members.clone());
            }
        }
    }

    // Per slice: each question's answer rank before, and after.
    type Ranks = (Vec<Option<usize>>, Vec<Option<usize>>);
    let mut by_slice: BTreeMap<Slice, Ranks> = BTreeMap::new();
    for q in &questions {
        let scope = scopes
            .iter()
            .find(|s| s.project_name == q.project)
            .context("question scope")?;
        let after = search(
            reader,
            embedder.as_ref(),
            scope.workspace_id,
            scope.project_id,
            &q.query,
        )
        .await?;
        let key = (q.project.clone(), q.path.clone());
        let answers = group
            .get(&key)
            .cloned()
            .unwrap_or_else(|| vec![q.path.clone()]);
        let slice = match (group.contains_key(&key), q.cold) {
            (true, _) => Slice::Merged,
            (false, true) => Slice::ColdUnmerged,
            (false, false) => Slice::Durable,
        };
        let entry = by_slice.entry(slice).or_default();
        entry.0.push(rank(&q.before, &answers));
        entry.1.push(rank(&after, &answers));
    }
    let scores = by_slice
        .into_iter()
        .map(|(slice, (before, after))| SliceScore {
            slice,
            before: score(&before),
            after: score(&after),
        })
        .collect();

    let facts = if args.dry_run {
        Facts::default()
    } else {
        check_facts(reader, embedder.as_ref(), &wiki, &scopes, &dream, &bodies).await?
    };

    let report = Report {
        source: args.source.display().to_string(),
        model_role: OMP_DEFAULT_MODEL,
        vectors: args.embedder,
        dry_run: args.dry_run,
        max_clusters_per_project: args.max_clusters,
        projects: scopes.len(),
        pages,
        cold_pages,
        dream,
        dream_wall_ms,
        llm: llm.usage(),
        profiles,
        scores,
        facts,
    };
    print_summary(&report);
    let out = args.out.unwrap_or_else(|| {
        let stamp = jiff::Timestamp::now().strftime("%Y-%m-%dT%H-%M-%SZ");
        PathBuf::from(format!("evals/runs/{stamp}-dream"))
    });
    std::fs::create_dir_all(&out)?;
    std::fs::write(
        out.join("report.json"),
        serde_json::to_string_pretty(&report)?,
    )?;
    println!("\nreport: {}", out.join("report.json").display());
    Ok(())
}

/// A consistent copy of `source`'s database and wiki under `dest`.
fn snapshot(source: &Path, dest: &Path) -> Result<()> {
    let db = source.join("db/memory.sqlite");
    if !db.is_file() {
        bail!("{} has no db/memory.sqlite", source.display());
    }
    std::fs::create_dir_all(dest.join("db"))?;
    let conn = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute(
        "VACUUM INTO ?1",
        [dest.join("db/memory.sqlite").to_string_lossy().as_ref()],
    )?;
    copy_dir(&source.join("wiki"), &dest.join("wiki"))
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if entry.file_type()?.is_file() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn now_us() -> i64 {
    jiff::Timestamp::now().as_microsecond()
}

/// One question per page: its `n` highest TF-IDF terms within the project.
/// Terms of one character class FTS reads badly (pure digits) are skipped.
fn known_item_queries(docs: &[(String, String, bool)], n: usize) -> Vec<(String, String)> {
    let counts: Vec<HashMap<String, u32>> = docs
        .iter()
        .map(|(_, body, _)| {
            let mut tf = HashMap::new();
            for term in lexical_terms(body).filter(|t| !t.chars().all(|c| c.is_ascii_digit())) {
                *tf.entry(term).or_insert(0) += 1;
            }
            tf
        })
        .collect();
    let mut df: HashMap<&str, u32> = HashMap::new();
    for tf in &counts {
        for term in tf.keys() {
            *df.entry(term.as_str()).or_insert(0) += 1;
        }
    }
    #[allow(clippy::cast_precision_loss)]
    let n_docs = docs.len() as f64;
    docs.iter()
        .zip(&counts)
        .filter_map(|((path, _, _), tf)| {
            let mut weighted: Vec<(&String, f64)> = tf
                .iter()
                .map(|(term, &count)| {
                    let idf = (n_docs / f64::from(df[term.as_str()])).ln();
                    (term, (1.0 + f64::from(count).ln()) * idf)
                })
                .collect();
            weighted.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            let terms: Vec<&str> = weighted.iter().take(n).map(|(t, _)| t.as_str()).collect();
            (terms.len() >= 2).then(|| (path.clone(), terms.join(" ")))
        })
        .collect()
}

/// The ceiling the pass applies: `max_eps`, or its default when unset.
fn ceiling(max_eps: f32) -> f32 {
    if max_eps > 0.0 {
        max_eps
    } else {
        ai_memory_consolidate::DEFAULT_DEDUP_MAX_EPS
    }
}

/// The zero-embedder `memory_query` search, or the hybrid one with the query's
/// vector when the store has an embedder.
async fn search(
    reader: &ReaderPool,
    embedder: Option<&Arc<dyn Embedder>>,
    ws: ai_memory_core::WorkspaceId,
    proj: ai_memory_core::ProjectId,
    query: &str,
) -> Result<Vec<String>> {
    let (vector, provider, model, dim) = match embedder {
        Some(e) => (
            Some(e.embed_query(query).await?),
            e.provider().to_string(),
            e.model_identity(),
            e.dim(),
        ),
        None => (None, String::new(), String::new(), 0),
    };
    let hits = reader
        .hybrid_search(
            ws,
            proj,
            query.to_string(),
            vector,
            provider,
            model,
            dim,
            K_MRR,
            Some(now_us()),
            false,
        )
        .await?;
    Ok(hits
        .into_iter()
        .map(|h| h.path.as_str().to_string())
        .collect())
}

fn coord(embedder: &Arc<dyn Embedder>) -> EmbeddingCoord {
    EmbeddingCoord {
        provider: embedder.provider().to_string(),
        model: embedder.model_identity(),
        dim: embedder.dim(),
    }
}

/// The server's default local embedder (all-MiniLM-L6-v2), its model fetched
/// into `--models` (or the snapshot) when missing, and every page of the
/// measured projects embedded into the snapshot, as the server's startup
/// backfill would.
async fn local_embedder(
    args: &DreamArgs,
    snapshot: &Path,
    store: &Store,
    wiki: &Wiki,
    scopes: &[ai_memory_store::ScopeRow],
) -> Result<Arc<dyn Embedder>> {
    let models = args
        .models
        .clone()
        .unwrap_or_else(|| snapshot.join("models"));
    if !ai_memory_llm::model_present(&models) {
        ai_memory_llm::fetch_model(&models).await?;
    }
    let embedder: Arc<dyn Embedder> = Arc::new(ai_memory_llm::LocalEmbedder::load(&models)?);
    for scope in scopes {
        ai_memory_consolidate::run_embedding_backfill(
            &store.reader,
            &store.writer,
            wiki,
            &embedder,
            scope.workspace_id,
            scope.project_id,
            ai_memory_consolidate::EmbedBackfillOptions::default(),
        )
        .await?;
    }
    Ok(embedder)
}

fn rank(results: &[String], answers: &[String]) -> Option<usize> {
    results.iter().position(|p| answers.contains(p))
}

fn score(ranks: &[Option<usize>]) -> Score {
    if ranks.is_empty() {
        return Score::default();
    }
    #[allow(clippy::cast_precision_loss)]
    let n = ranks.len() as f64;
    #[allow(clippy::cast_precision_loss)]
    Score {
        questions: ranks.len(),
        recall_at_5: ranks
            .iter()
            .filter(|r| r.is_some_and(|r| r < K_RECALL))
            .count() as f64
            / n,
        mrr_at_10: ranks
            .iter()
            .map(|r| {
                r.filter(|r| *r < K_MRR)
                    .map_or(0.0, |r| 1.0 / (r as f64 + 1.0))
            })
            .sum::<f64>()
            / n,
    }
}

/// How far apart the project's cold pages sit by the vectors the pass clusters
/// (lexical ones are computed over every latest page, as the pass does), and
/// how many clusters a fixed eps would form.
fn profile(project: &str, cold: &[Vec<f32>], max_eps: f32) -> Profile {
    let mut nn: Vec<f32> = cold
        .iter()
        .enumerate()
        .map(|(i, v)| {
            cold.iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, w)| cosine_distance(v, w))
                .fold(f32::INFINITY, f32::min)
        })
        .filter(|d| d.is_finite())
        .collect();
    nn.sort_by(f32::total_cmp);
    let pct = |p: usize| nn.get(nn.len() * p / 100).copied().unwrap_or(f32::NAN);
    Profile {
        project: project.to_string(),
        cold_pages: cold.len(),
        nn_distance: [pct(10), pct(25), pct(50)],
        adaptive_eps: adaptive_eps(cold, 2, max_eps),
        clusters_at: PROFILE_EPS
            .iter()
            .map(|&eps| {
                let clusters = dbscan(cold, eps, 2);
                (eps, clusters.len(), clusters.iter().map(Vec::len).sum())
            })
            .collect(),
    }
}

/// Every keep-token of every merged source, looked for in the rewritten survivor
/// and searched for on its own; and the rewrite's keep-tokens no source holds.
async fn check_facts(
    reader: &ReaderPool,
    embedder: Option<&Arc<dyn Embedder>>,
    wiki: &Wiki,
    scopes: &[ai_memory_store::ScopeRow],
    dream: &[(String, DreamReport)],
    bodies: &HashMap<(String, String), String>,
) -> Result<Facts> {
    let mut facts = Facts::default();
    for (project, report) in dream {
        let scope = scopes
            .iter()
            .find(|s| &s.project_name == project)
            .context("merge scope")?;
        for merge in report.merges.iter().filter(|m| m.applied) {
            let survivor = PagePath::new(merge.survivor.clone())?;
            let rewritten = wiki
                .read_page(scope.workspace_id, scope.project_id, &survivor)?
                .body;
            // The pass's own footer names the merged paths; only the model's
            // text counts as kept or invented.
            let written = rewritten
                .rsplit_once("\n\n_Merged ")
                .map_or(rewritten.as_str(), |(text, _)| text);
            let mut sources = vec![merge.survivor.clone()];
            sources.extend(merge.merged.iter().cloned());
            let source_text: Vec<&str> = sources
                .iter()
                .filter_map(|p| bodies.get(&(project.clone(), p.clone())))
                .map(String::as_str)
                .collect();
            let mut seen = HashSet::new();
            for body in &source_text {
                for token in mine_keep_tokens(body) {
                    if !seen.insert(token.clone()) {
                        continue;
                    }
                    facts.total += 1;
                    if written.contains(&token) {
                        facts.kept += 1;
                    } else {
                        facts.lost.push(format!("{}: {token}", merge.survivor));
                    }
                    let found = search(
                        reader,
                        embedder,
                        scope.workspace_id,
                        scope.project_id,
                        &token,
                    )
                    .await?;
                    if found.contains(&merge.survivor) {
                        facts.findable += 1;
                    }
                }
            }
            facts.invented += mine_keep_tokens(written)
                .iter()
                .filter(|t| !source_text.iter().any(|s| s.contains(t.as_str())))
                .count();
        }
    }
    Ok(facts)
}

fn print_summary(report: &Report) {
    println!(
        "dream eval: {} projects, {} pages, {} cold; role {}{}",
        report.projects,
        report.pages,
        report.cold_pages,
        report.model_role,
        if report.dry_run { " (dry run)" } else { "" }
    );
    println!(
        "\n| project | cold | nn p10/p25/p50 | adaptive eps | clusters @0.10/0.15/0.20/0.30 |"
    );
    println!("|---|---:|---|---:|---|");
    for p in &report.profiles {
        let at = |eps: f32| {
            p.clusters_at
                .iter()
                .find(|(e, _, _)| (*e - eps).abs() < 1e-6)
                .map_or(String::new(), |(_, c, n)| format!("{c}({n})"))
        };
        println!(
            "| {} | {} | {:.2}/{:.2}/{:.2} | {} | {} {} {} {} |",
            p.project,
            p.cold_pages,
            p.nn_distance[0],
            p.nn_distance[1],
            p.nn_distance[2],
            p.adaptive_eps.map_or("-".into(), |e| format!("{e:.3}")),
            at(0.10),
            at(0.15),
            at(0.20),
            at(0.30)
        );
    }
    let considered: usize = report
        .dream
        .iter()
        .map(|(_, r)| r.clusters_considered)
        .sum();
    let merged: usize = report.dream.iter().map(|(_, r)| r.clusters_merged).sum();
    let superseded: usize = report.dream.iter().map(|(_, r)| r.pages_superseded).sum();
    let skipped: usize = report.dream.iter().map(|(_, r)| r.skipped).sum();
    println!(
        "\ndream: {considered} clusters considered, {merged} merged, {superseded} pages superseded, {skipped} skipped; {} ms",
        report.dream_wall_ms
    );
    println!(
        "llm: {} calls, {} input + {} output tokens, ${:.4}",
        report.llm.calls, report.llm.input_tokens, report.llm.output_tokens, report.llm.cost_usd
    );
    println!("\n| slice | questions | recall@5 before → after | MRR@10 before → after |");
    println!("|---|---:|---|---|");
    for s in &report.scores {
        println!(
            "| {:?} | {} | {:.3} → {:.3} | {:.3} → {:.3} |",
            s.slice,
            s.before.questions,
            s.before.recall_at_5,
            s.after.recall_at_5,
            s.before.mrr_at_10,
            s.after.mrr_at_10
        );
    }
    if !report.dry_run {
        let f = &report.facts;
        println!(
            "\nfacts of merged sources: {} total, {} kept in the survivor, {} findable alone, {} invented",
            f.total, f.kept, f.findable, f.invented
        );
    }
}
