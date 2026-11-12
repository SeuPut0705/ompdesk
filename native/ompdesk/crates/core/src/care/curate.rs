//! Curate, the pure part (7d; was the pairing and deciding of `src/main/ai-memory/curate.ts`): which durable pages are
//! candidates for repeating or contradicting each other, what the code rule says of a pair, and who goes when a judge
//! has spoken; then the run (`curate_memory`: reading the pages, asking the judge, retiring).
//!
//! A pair holds indices into the page slice the caller built, where the TypeScript held the pages themselves.
//!
//! Numbers equal V8's: the weights use `Math.log`, which V8 computes with fdlibm (`aimemory::value::js_log` is a port; the
//! platform's `f64::ln` differs in the last digit for about one weight in twelve), sums run in the terms' insertion
//! order, and `weight ** 2` is `weight * weight` (equal for every weight the TypeScript computed). A tie in `updatedAt` is
//! broken by `localeCompare` on the page key: ICU collation of the locale main's `localeCompare` resolves
//! (`Intl.Collator().resolvedOptions().locale`), which every caller passes as `locale` (an unknown one reads as the root
//! collation); the order differs between locales only for text a locale tailors (Hangul against Latin in Korean, ä in
//! Swedish).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::json;

use super::durable::is_durable_path;
use super::engine::Writer;
use super::judge::{Judge, JudgedBy, PagePair};
use super::{Ctx, is_cancelled, join_all, js_round};
use crate::aimemory::ops::{PageAt, PageRef, ProjectRef, RetireInput};
use crate::aimemory::value::{js_log, js_order};
use crate::care::judge::{
    PAGE_CHARS, PageDigest, PairVerdict, Relation, Scope, body_text, cut_units, page_text,
};
use crate::fs::order::NameOrder;
use crate::server::Fault;
use crate::upkeep::distill::GLOBAL_PROJECT;
use crate::upkeep::rules_file::{Terms, content_terms, read_rules_text, rules_outline};
use crate::upkeep::store::Retired;

/// Pairs judged in one run: bounds the model cost; the rest follow in later runs.
pub const CURATE_MAX_PAIRS: usize = 30;
/// A page is compared with its closest few; a pair needs at least this weighted cosine to be a candidate.
pub const CANDIDATE_NEIGHBOURS: usize = 3;
pub const CANDIDATE_FLOOR: f64 = 0.1;
/// The code rule retires a copy only when title and body share at least this fraction of their terms.
pub const NEAR_IDENTICAL: f64 = 0.8;
/// Durable pages read per project, newest first.
pub const CURATE_MAX_PAGES: usize = 400;

/// What decided a pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CurateBy {
    Jev,
    Smol,
    Code,
}

/// A durable page as curation reads it (`CuratePage` and the `AiMemoryPage` behind it, fields that are read).
#[derive(Clone, Debug)]
pub struct CuratePage {
    pub workspace: String,
    pub project: String,
    pub path: String,
    /// The latest version's id; changes with every write.
    pub id: String,
    pub title: String,
    pub kind: Option<String>,
    pub updated_at: Option<String>,
    pub markdown: String,
    pub pinned: bool,
    /// The owner's `_global` page, not a project's.
    pub global: bool,
    /// `terms_of(title, markdown)`.
    pub terms: Terms,
}

/// A pair worth asking about: `a` is the older page, `b` the newer one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    pub a: usize,
    pub b: usize,
    pub score: f64,
}

/// Who goes, and why.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Decision {
    pub loser: usize,
    pub winner: usize,
    /// Never `Unrelated`.
    pub relation: Relation,
    pub by: CurateBy,
    pub confidence: f64,
    pub score: f64,
}

/// `${workspace}/${project}/${path}`.
pub fn page_key(page: &CuratePage) -> String {
    format!("{}/{}/{}", page.workspace, page.project, page.path)
}

/// A pair's identity: both pages at the versions that were compared, order-free.
pub fn pair_key(a: &CuratePage, b: &CuratePage) -> String {
    let mut keys = [a, b].map(|page| format!("{}@{}", page_key(page), page.id));
    keys.sort_by(|left, right| js_order(left, right));
    keys.join("|")
}

/// Terms of the whole page: the code rule calls a duplicate only on what both pages say in full.
pub fn terms_of(title: &str, markdown: &str) -> Terms {
    content_terms(&format!("{title}\n{title}\n{}", body_text(markdown)))
}

/// The judge read this page cut at `PAGE_CHARS`: what it said may hang on the part it never saw.
pub fn cut_for_judge(page: &CuratePage) -> bool {
    body_text(&page.markdown).encode_utf16().count() > PAGE_CHARS
}

/// `x.updatedAt ?? ""` order, then the page key: the older of the two pages first.
fn older_first(order: &NameOrder, pages: &[CuratePage], x: usize, y: usize) -> (usize, usize) {
    let time = |index: usize| pages[index].updated_at.as_deref().unwrap_or("");
    let by_time = order.compare(time(x), time(y));
    let ordering = by_time.then_with(|| order.compare(&page_key(&pages[x]), &page_key(&pages[y])));
    if ordering == Ordering::Greater {
        (y, x)
    } else {
        (x, y)
    }
}

/// `olderFirst`: the pair `(older, newer)` of two pages, `x` first when they are equal.
pub fn older_first_of(pages: &[CuratePage], x: usize, y: usize, locale: &str) -> (usize, usize) {
    older_first(&NameOrder::text(locale), pages, x, y)
}

/// A descending sort by score that keeps the earlier of equal scores first, as `sort((x, y) => y.score - x.score)`.
fn by_score_descending(left: &Candidate, right: &Candidate) -> Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(Ordering::Equal)
}

/// Weighted term cosine of every allowed pair, each page's closest `CANDIDATE_NEIGHBOURS` above the floor, best first.
pub fn candidate_pairs(pages: &[CuratePage], locale: &str) -> Vec<Candidate> {
    let order = NameOrder::text(locale);
    let mut df: HashMap<&str, usize> = HashMap::new();
    for page in pages {
        for term in page.terms.iter() {
            *df.entry(term).or_insert(0) += 1;
        }
    }
    let total = pages.len() as f64;
    // `weight(term) ** 2`, once per term.
    let squares: HashMap<&str, f64> = df
        .iter()
        .map(|(term, count)| {
            let weight = js_log(1.0 + total / *count as f64);
            (*term, weight * weight)
        })
        .collect();
    let norms: Vec<f64> = pages
        .iter()
        .map(|page| {
            let mut sum = 0.0;
            for term in page.terms.iter() {
                sum += squares[term];
            }
            sum.sqrt()
        })
        .collect();
    let mut scored: Vec<Vec<usize>> = vec![Vec::new(); pages.len()];
    let mut pairs: Vec<Candidate> = Vec::new();
    for i in 0..pages.len() {
        for j in i + 1..pages.len() {
            let (first, second) = (&pages[i], &pages[j]);
            if first.workspace != second.workspace {
                continue;
            }
            if first.project != second.project && !first.global && !second.global {
                continue;
            }
            let mut dot = 0.0;
            for term in first.terms.iter() {
                if second.terms.contains(term) {
                    dot += squares[term];
                }
            }
            let norm = norms[i] * norms[j];
            let score = dot
                / if norm == 0.0 || norm.is_nan() {
                    1.0
                } else {
                    norm
                };
            if score < CANDIDATE_FLOOR {
                continue;
            }
            let (a, b) = older_first(&order, pages, i, j);
            let at = pairs.len();
            pairs.push(Candidate { a, b, score });
            scored[i].push(at);
            scored[j].push(at);
        }
    }
    let mut keep = vec![false; pairs.len()];
    for list in &mut scored {
        list.sort_by(|left, right| by_score_descending(&pairs[*left], &pairs[*right]));
        for at in list.iter().take(CANDIDATE_NEIGHBOURS) {
            keep[*at] = true;
        }
    }
    let mut kept: Vec<Candidate> = pairs
        .into_iter()
        .zip(keep)
        .filter_map(|(pair, keep)| keep.then_some(pair))
        .collect();
    kept.sort_by(by_score_descending);
    kept
}

/// What a judge reads of a page.
pub fn digest(page: &CuratePage) -> PageDigest {
    PageDigest {
        path: page.path.clone(),
        title: page.title.clone(),
        kind: page.kind.clone().unwrap_or_default(),
        saved: cut_units(page.updated_at.as_deref().unwrap_or(""), 10),
        scope: if page.global {
            Scope::Global
        } else {
            Scope::Project
        },
        text: page_text(&page.markdown),
    }
}

/// Title and body terms they share, of all they hold (Jaccard).
pub fn overlap(a: &Terms, b: &Terms) -> f64 {
    let shared = a.iter().filter(|term| b.contains(term)).count();
    let all = a.len() + b.len() - shared;
    shared as f64 / if all == 0 { 1 } else { all } as f64
}

/// The code rule: only a near-identical copy is a duplicate; it never calls a contradiction.
pub fn code_verdict(pages: &[CuratePage], pair: &Candidate) -> Option<PairVerdict> {
    let similarity = overlap(&pages[pair.a].terms, &pages[pair.b].terms);
    (similarity >= NEAR_IDENTICAL).then_some(PairVerdict {
        relation: Relation::Duplicate,
        confidence: similarity,
    })
}

/// Who goes, or `None`: unrelated, or a contradiction between a project and its `_global`.
pub fn decide(
    pages: &[CuratePage],
    pair: &Candidate,
    verdict: &PairVerdict,
    by: CurateBy,
) -> Option<Decision> {
    let cross = pages[pair.a].global != pages[pair.b].global;
    let decision = |loser: usize, winner: usize, relation: Relation| Decision {
        loser,
        winner,
        relation,
        by,
        confidence: verdict.confidence,
        score: pair.score,
    };
    match verdict.relation {
        Relation::Duplicate => {
            let (loser, winner) = if cross && pages[pair.b].global {
                (pair.a, pair.b)
            } else if cross {
                (pair.b, pair.a)
            } else {
                (pair.a, pair.b)
            };
            Some(decision(loser, winner, Relation::Duplicate))
        }
        Relation::AOutdated => (!cross).then(|| decision(pair.a, pair.b, Relation::AOutdated)),
        Relation::BOutdated => (!cross).then(|| decision(pair.b, pair.a, Relation::BOutdated)),
        Relation::Unrelated => None,
    }
}

/// Pairs grouped by the project whose rules file the judge is shown (a `_global` pair has none), in the order each
/// group's first pair came. The key is `workspace\0project`, or empty for `_global`.
pub fn group_by_project(
    pages: &[CuratePage],
    pairs: &[Candidate],
) -> Vec<(String, Vec<Candidate>)> {
    let mut groups: Vec<(String, Vec<Candidate>)> = Vec::new();
    for pair in pairs {
        let owner = &pages[if pages[pair.a].global { pair.b } else { pair.a }];
        let key = if owner.global {
            String::new()
        } else {
            format!("{}\u{0}{}", owner.workspace, owner.project)
        };
        match groups.iter_mut().find(|(name, _)| *name == key) {
            Some((_, group)) => group.push(*pair),
            None => groups.push((key, vec![*pair])),
        }
    }
    groups
}

/// `decisions.sort((x, y) => y.confidence - x.confidence || y.score - x.score)`: the surest verdicts first, then the
/// closest pairs; equal ones keep their order.
pub fn sort_decisions(decisions: &mut [Decision]) {
    // `a || b` takes `b` when `a` is 0 or NaN.
    let sign = |value: f64| value.partial_cmp(&0.0).unwrap_or(Ordering::Equal);
    decisions.sort_by(|x, y| {
        let by_confidence = y.confidence - x.confidence;
        if by_confidence == 0.0 || by_confidence.is_nan() {
            sign(y.score - x.score)
        } else {
            sign(by_confidence)
        }
    });
}

/// Pages read at once.
const READ_BATCH: usize = 8;

/// What a run is asked.
#[derive(Default)]
pub struct Options {
    /// Report what would retire; write and log nothing about pages.
    pub dry_run: bool,
    pub max_pairs: Option<usize>,
    /// `pair_key`s an earlier run judged unrelated.
    pub skip: HashSet<String>,
    /// Show the judge each project's rules-file outline (`project_rules`).
    pub project_rules: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Retired,
    Planned,
    Pinned,
    Changed,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retirement {
    pub workspace: String,
    pub project: String,
    pub path: String,
    pub title: String,
    /// The page kept, as `<project>/<path>`.
    pub successor: String,
    pub relation: Relation,
    pub by: CurateBy,
    pub confidence: f64,
    pub result: Outcome,
}

#[derive(Debug, Default, Serialize)]
pub struct By {
    pub jev: usize,
    pub smol: usize,
    pub code: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub dry_run: bool,
    pub projects: usize,
    pub pages: usize,
    /// Candidate pairs found, before the cap and the skip list.
    pub candidates: usize,
    /// Pairs asked of a judge or the code rule.
    pub judged: usize,
    pub retirements: Vec<Retirement>,
    /// Pairs judged unrelated: remember them and pass them back as `skip`.
    pub unrelated: Vec<String>,
    /// Pairs nobody decided (no judge, or it gave no readable verdict).
    pub undecided: usize,
    pub by: By,
    /// The models that answered (a judge's own account of who billed).
    pub models: Vec<String>,
    pub cost_usd: f64,
    pub ms: f64,
}

/// The durable pages of every project, read whole; a project the server cannot list and a page it cannot read are
/// left out.
async fn load_pages(ctx: &Ctx) -> Result<(Vec<CuratePage>, usize), Fault> {
    let mut counted = 0;
    let mut pages = Vec::new();
    for project in ctx.store.projects().await? {
        let at = ProjectRef {
            workspace: project.workspace.clone(),
            project: project.project.clone(),
        };
        // One project the server cannot list never keeps the others from being curated.
        let listed = match ctx.store.pages(&at).await {
            Ok(listed) => listed,
            Err(fault) if is_cancelled(&fault) => return Err(fault),
            Err(_) => continue,
        };
        let refs: Vec<PageRef> = listed
            .into_iter()
            .filter(|page| is_durable_path(&page.path))
            .take(CURATE_MAX_PAGES)
            .collect();
        if refs.is_empty() {
            continue;
        }
        counted += 1;
        for batch in refs.chunks(READ_BATCH) {
            let reads = join_all(
                batch
                    .iter()
                    .map(|page| {
                        let at = PageAt {
                            project: at.clone(),
                            path: page.path.clone(),
                        };
                        async move { ctx.store.page(&at).await }
                    })
                    .collect(),
            )
            .await;
            for read in reads {
                match read {
                    Ok(page) => {
                        let terms = terms_of(&page.title, &page.markdown);
                        pages.push(CuratePage {
                            workspace: page.workspace,
                            project: page.project,
                            path: page.path,
                            id: page.id,
                            title: page.title,
                            kind: page.kind,
                            updated_at: page.updated_at,
                            markdown: page.markdown,
                            pinned: page.pinned,
                            global: project.project == GLOBAL_PROJECT.project,
                            terms,
                        });
                    }
                    Err(fault) if is_cancelled(&fault) => return Err(fault),
                    // A page that cannot be read is left out.
                    Err(_) => {}
                }
            }
        }
    }
    Ok((pages, counted))
}

/// The rules-file outline of the repository the project's newest session ran in (the folder upkeep's learn step reads
/// the same way): empty for no such folder. A test's own reader answers the ask `rules` `{cwd}`.
pub async fn project_rules(ctx: &Ctx, project: &ProjectRef) -> Result<String, Fault> {
    let sessions = ctx.store.sessions(project, Some(20), None).await?;
    let cwd = sessions
        .iter()
        .find(|session| !session.cwd.is_empty())
        .map(|session| session.cwd.clone())
        .unwrap_or_default();
    let text = if ctx.asked("rules") {
        let answer = ctx.asker.ask("rules", json!({ "cwd": cwd })).await?;
        answer
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Fault::new("memory_main", "rules answered another shape than text"))?
    } else {
        read_rules_text(&cwd).await
    };
    Ok(rules_outline(&text))
}

/// Memory curation: durable pages that repeat or contradict each other leave default recall, the older one first.
///
/// 1. Every durable page of every project, with its body.
/// 2. Candidate pairs, cheaply: the same project, or a project and its workspace's `_global`; weighted term cosine,
///    each page's closest neighbours above a floor, best first, at most `max_pairs` a run, never a pair an earlier run
///    already found unrelated (`skip`).
/// 3. A judge says duplicate / the newer makes the older wrong / the older is current / unrelated. A pair it left
///    undecided is judged by the code rule, which only ever retires a near-identical copy.
/// 4. The loser retires with the winner named as its successor, conditional on the version that was judged. A
///    duplicate keeps the newer page (across a project and `_global` the project copy goes); a contradiction is
///    retired only inside one project.
///
/// Idempotent: a retired page is hidden from the page list, so it is never a candidate again. Nothing is deleted.
pub async fn curate_memory(
    ctx: &Ctx,
    writer: &Writer<'_>,
    judge: Option<&Judge<'_>>,
    options: &Options,
) -> Result<Report, Fault> {
    let started = std::time::Instant::now();
    let at = ctx.clock.iso();
    let (pages, projects) = load_pages(ctx).await?;
    let all = candidate_pairs(&pages, &ctx.locale);
    let fresh: Vec<Candidate> = all
        .iter()
        .filter(|pair| {
            !options
                .skip
                .contains(&pair_key(&pages[pair.a], &pages[pair.b]))
        })
        .copied()
        .collect();
    let asked: Vec<Candidate> = fresh
        .into_iter()
        .take(options.max_pairs.unwrap_or(CURATE_MAX_PAIRS))
        .collect();
    let mut report = Report {
        dry_run: options.dry_run,
        projects,
        pages: pages.len(),
        candidates: all.len(),
        judged: asked.len(),
        retirements: Vec::new(),
        unrelated: Vec::new(),
        undecided: 0,
        by: By::default(),
        models: Vec::new(),
        cost_usd: 0.0,
        ms: 0.0,
    };

    let mut decisions: Vec<Decision> = Vec::new();
    for (owner, group) in group_by_project(&pages, &asked) {
        let mut names = owner.split('\u{0}');
        let (workspace, project) = (names.next().unwrap_or_default(), names.next());
        let rules = match project {
            Some(project) if !owner.is_empty() && options.project_rules && !project.is_empty() => {
                let project = ProjectRef {
                    workspace: workspace.to_owned(),
                    project: project.to_owned(),
                };
                project_rules(ctx, &project).await.unwrap_or_default()
            }
            _ => String::new(),
        };
        let judgment = match judge {
            Some(judge) => {
                let pairs: Vec<PagePair> = group
                    .iter()
                    .map(|pair| PagePair {
                        a: digest(&pages[pair.a]),
                        b: digest(&pages[pair.b]),
                    })
                    .collect();
                judge.judge(&pairs, &rules).await?
            }
            None => None,
        };
        if let Some(judgment) = &judgment {
            report.cost_usd += judgment.cost_usd;
            if !report.models.contains(&judgment.model) {
                report.models.push(judgment.model.clone());
            }
        }
        for (index, pair) in group.iter().enumerate() {
            let answered = judgment
                .as_ref()
                .and_then(|judgment| judgment.verdicts.get(index).copied().flatten());
            // A judge that saw only the start of a long page may call two pages one; that never retires a page by
            // itself.
            let model_verdict = match answered {
                Some(verdict)
                    if verdict.relation != Relation::Unrelated
                        && (cut_for_judge(&pages[pair.a]) || cut_for_judge(&pages[pair.b])) =>
                {
                    None
                }
                other => other,
            };
            let verdict = model_verdict.or_else(|| code_verdict(&pages, pair));
            let by = match (&model_verdict, &judgment) {
                (Some(_), Some(judgment)) => match judgment.by {
                    JudgedBy::Jev => CurateBy::Jev,
                    JudgedBy::Smol => CurateBy::Smol,
                },
                _ => CurateBy::Code,
            };
            let Some(verdict) = verdict else {
                report.undecided += 1;
                continue;
            };
            match by {
                CurateBy::Jev => report.by.jev += 1,
                CurateBy::Smol => report.by.smol += 1,
                CurateBy::Code => report.by.code += 1,
            }
            match decide(&pages, pair, &verdict, by) {
                Some(decision) => decisions.push(decision),
                None if verdict.relation == Relation::Unrelated => report
                    .unrelated
                    .push(pair_key(&pages[pair.a], &pages[pair.b])),
                None => {}
            }
        }
    }

    // The surest verdicts first; a page already kept for one pair is never retired for another, nor one retired kept.
    sort_decisions(&mut decisions);
    let mut retired: HashSet<String> = HashSet::new();
    let mut kept: HashSet<String> = HashSet::new();
    for decision in decisions {
        let (loser, winner) = (&pages[decision.loser], &pages[decision.winner]);
        let (loser_key, winner_key) = (page_key(loser), page_key(winner));
        if kept.contains(&loser_key)
            || retired.contains(&winner_key)
            || retired.contains(&loser_key)
            || loser.pinned
        {
            continue;
        }
        retired.insert(loser_key);
        kept.insert(winner_key);
        let mut retirement = Retirement {
            workspace: loser.workspace.clone(),
            project: loser.project.clone(),
            path: loser.path.clone(),
            title: loser.title.clone(),
            successor: format!("{}/{}", winner.project, winner.path),
            relation: decision.relation,
            by: decision.by,
            confidence: js_round(decision.confidence * 100.0) / 100.0,
            result: Outcome::Planned,
        };
        if !options.dry_run {
            let page = PageAt {
                project: ProjectRef {
                    workspace: loser.workspace.clone(),
                    project: loser.project.clone(),
                },
                path: loser.path.clone(),
            };
            let input = RetireInput {
                when: at.clone(),
                expected_page_id: Some(loser.id.clone()),
                successor: Some(winner.path.clone()),
                reason: None,
            };
            retirement.result = match writer.retire_page(&page, &input).await {
                Ok(Retired::Retired) => Outcome::Retired,
                Ok(Retired::Pinned) => Outcome::Pinned,
                Ok(Retired::Changed) => Outcome::Changed,
                Err(fault) if is_cancelled(&fault) => return Err(fault),
                Err(_) => Outcome::Failed,
            };
            if retirement.result == Outcome::Retired {
                ctx.log(
                    "care-curate",
                    json!({
                        "event": "retire",
                        "workspace": retirement.workspace,
                        "project": retirement.project,
                        "path": retirement.path,
                        "successor": retirement.successor,
                        "relation": retirement.relation,
                        "by": retirement.by,
                        "confidence": retirement.confidence,
                    }),
                );
            }
        }
        report.retirements.push(retirement);
    }

    report.ms = js_round(started.elapsed().as_secs_f64() * 1000.0);
    if !options.dry_run {
        let retired = report
            .retirements
            .iter()
            .filter(|item| item.result == Outcome::Retired)
            .count();
        ctx.log(
            "care-curate",
            json!({
                "event": "run",
                "projects": report.projects,
                "pages": report.pages,
                "candidates": report.candidates,
                "judged": report.judged,
                "retired": retired,
                "skipped": report.retirements.len() - retired,
                "unrelated": report.unrelated.len(),
                "undecided": report.undecided,
                "jev": report.by.jev,
                "smol": report.by.smol,
                "code": report.by.code,
                "models": report.models.join(","),
                "costUsd": js_round(report.cost_usd * 1e6) / 1e6,
                "ms": report.ms,
            }),
        );
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn table() -> Value {
        serde_json::from_str(include_str!("curate-captured.json")).unwrap()
    }

    fn rows(name: &str) -> Vec<Value> {
        table()[name].as_array().unwrap().clone()
    }

    fn text(value: &Value) -> &str {
        value.as_str().unwrap()
    }

    fn page_of(row: &Value) -> CuratePage {
        let optional = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        let title = text(&row["title"]);
        let markdown = text(&row["markdown"]);
        CuratePage {
            workspace: text(&row["workspace"]).into(),
            project: text(&row["project"]).into(),
            path: text(&row["path"]).into(),
            id: text(&row["id"]).into(),
            title: title.into(),
            kind: optional("kind"),
            updated_at: optional("updatedAt"),
            markdown: markdown.into(),
            pinned: row["pinned"].as_bool().unwrap(),
            global: row["project"] == "_global",
            terms: terms_of(title, markdown),
        }
    }

    fn pages_of(row: &Value) -> Vec<CuratePage> {
        row["pages"]
            .as_array()
            .unwrap()
            .iter()
            .map(page_of)
            .collect()
    }

    fn terms(list: &Value) -> Vec<&str> {
        list.as_array().unwrap().iter().map(text).collect()
    }

    fn relation(name: &str) -> Relation {
        match name {
            "duplicate" => Relation::Duplicate,
            "a_outdated" => Relation::AOutdated,
            "b_outdated" => Relation::BOutdated,
            "unrelated" => Relation::Unrelated,
            other => panic!("{other}"),
        }
    }

    fn by(name: &str) -> CurateBy {
        match name {
            "jev" => CurateBy::Jev,
            "smol" => CurateBy::Smol,
            "code" => CurateBy::Code,
            other => panic!("{other}"),
        }
    }

    fn same_number(got: f64, want: &Value, what: &str) {
        assert_eq!(
            got.to_bits(),
            want.as_f64().unwrap().to_bits(),
            "{what}: {got} against {want}"
        );
    }

    #[test]
    fn the_logarithm_is_v8s() {
        let rows = rows("log");
        assert_eq!(rows.len(), 2000);
        for row in &rows {
            let x = row["x"].as_f64().unwrap();
            same_number(js_log(x), &row["ln"], &format!("log({x})"));
        }
    }

    #[test]
    fn pairs_match_the_captured_rows() {
        let rows = rows("pairing");
        assert_eq!(rows.len(), 94);
        let mut pair_count = 0;
        for (number, row) in rows.iter().enumerate() {
            let pages = pages_of(row);
            for (page, want) in pages.iter().zip(row["terms"].as_array().unwrap()) {
                assert_eq!(
                    page.terms.iter().collect::<Vec<_>>(),
                    terms(want),
                    "terms in row {number}"
                );
            }
            let got = candidate_pairs(&pages, text(&row["locale"]));
            let want = row["pairs"].as_array().unwrap();
            assert_eq!(got.len(), want.len(), "row {number}");
            for (got, want) in got.iter().zip(want) {
                assert_eq!(
                    (got.a, got.b),
                    (
                        want["a"].as_u64().unwrap() as usize,
                        want["b"].as_u64().unwrap() as usize
                    ),
                    "row {number}"
                );
                same_number(got.score, &want["score"], &format!("score in row {number}"));
            }
            pair_count += got.len();
            for key in row["keys"].as_array().unwrap() {
                let (a, b) = (
                    key["a"].as_u64().unwrap() as usize,
                    key["b"].as_u64().unwrap() as usize,
                );
                assert_eq!(pair_key(&pages[a], &pages[b]), text(&key["key"]));
            }
            for (page, want) in pages.iter().zip(row["digests"].as_array().unwrap()) {
                let digest = digest(page);
                assert_eq!(
                    serde_json::to_value(&digest).unwrap(),
                    want["digest"],
                    "digest in row {number}"
                );
                assert_eq!(
                    cut_for_judge(page),
                    want["cut"].as_bool().unwrap(),
                    "cut in row {number}"
                );
            }
        }
        assert!(pair_count > 150, "{pair_count}");
    }

    #[test]
    fn the_older_page_goes_first() {
        let rows = rows("olderFirst");
        assert_eq!(rows.len(), 60);
        for row in &rows {
            let pages = pages_of(row);
            let (a, b) = older_first_of(&pages, 0, 1, text(&row["locale"]));
            let want = row["first"].as_u64().unwrap() as usize;
            assert_eq!(a, want, "{row}");
            assert_eq!(b, 1 - want, "{row}");
        }
    }

    #[test]
    fn overlap_and_the_code_rule_match_the_captured_rows() {
        let rows = rows("overlap");
        assert_eq!(rows.len(), 40);
        for row in &rows {
            let pages = pages_of(row);
            let got = overlap(&pages[0].terms, &pages[1].terms);
            same_number(got, &row["overlap"], &format!("{row}"));
            let pair = Candidate {
                a: 0,
                b: 1,
                score: 0.5,
            };
            match (&code_verdict(&pages, &pair), &row["verdict"]) {
                (None, Value::Null) => {}
                (Some(verdict), want) => {
                    assert_eq!(verdict.relation, Relation::Duplicate);
                    same_number(verdict.confidence, &want["confidence"], "confidence");
                }
                (got, want) => panic!("{got:?} against {want}"),
            }
        }
    }

    #[test]
    fn decisions_match_the_captured_rows() {
        let rows = rows("decide");
        assert_eq!(rows.len(), 96);
        for row in &rows {
            let global = |key: &str| row[key].as_bool().unwrap();
            let make = |global: bool| CuratePage {
                workspace: "default".into(),
                project: if global { "_global" } else { "demo" }.into(),
                path: "decisions/x.md".into(),
                id: "id".into(),
                title: "t".into(),
                kind: None,
                updated_at: None,
                markdown: String::new(),
                pinned: false,
                global,
                terms: Terms::default(),
            };
            let pages = [make(global("aGlobal")), make(global("bGlobal"))];
            let pair = Candidate {
                a: 0,
                b: 1,
                score: row["score"].as_f64().unwrap(),
            };
            let verdict = PairVerdict {
                relation: relation(text(&row["relation"])),
                confidence: row["confidence"].as_f64().unwrap(),
            };
            let got = decide(&pages, &pair, &verdict, by(text(&row["by"])));
            match (got, &row["decision"]) {
                (None, Value::Null) => {}
                (Some(got), want) => {
                    let name = |index: usize| if index == 0 { "a" } else { "b" };
                    assert_eq!(name(got.loser), text(&want["loser"]), "{row}");
                    assert_eq!(name(got.winner), text(&want["winner"]), "{row}");
                    assert_eq!(got.relation.as_str(), text(&want["relation"]), "{row}");
                    assert_eq!(got.by, by(text(&want["by"])), "{row}");
                    same_number(got.confidence, &want["confidence"], "confidence");
                    same_number(got.score, &want["score"], "score");
                }
                (got, want) => panic!("{got:?} against {want}"),
            }
        }
    }

    #[test]
    fn groups_match_the_captured_rows() {
        let rows = rows("groups");
        assert_eq!(rows.len(), 30);
        for row in &rows {
            let pages = pages_of(row);
            let pairs: Vec<Candidate> = row["pairs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|pair| Candidate {
                    a: pair["a"].as_u64().unwrap() as usize,
                    b: pair["b"].as_u64().unwrap() as usize,
                    score: 0.5,
                })
                .collect();
            let got = group_by_project(&pages, &pairs);
            let want = row["groups"].as_array().unwrap();
            assert_eq!(got.len(), want.len(), "{row}");
            for ((key, group), want) in got.iter().zip(want) {
                assert_eq!(key, text(&want["key"]));
                let indices: Vec<(u64, u64)> = group
                    .iter()
                    .map(|pair| (pair.a as u64, pair.b as u64))
                    .collect();
                let wanted: Vec<(u64, u64)> = want["pairs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|pair| (pair["a"].as_u64().unwrap(), pair["b"].as_u64().unwrap()))
                    .collect();
                assert_eq!(indices, wanted);
            }
        }
    }

    #[test]
    fn decisions_sort_as_the_typescript_sorted_them() {
        let rows = rows("sortDecisions");
        assert_eq!(rows.len(), 40);
        for row in &rows {
            let mut decisions: Vec<Decision> = row["input"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(index, item)| Decision {
                    loser: index,
                    winner: index,
                    relation: Relation::Duplicate,
                    by: CurateBy::Code,
                    confidence: item["confidence"].as_f64().unwrap(),
                    score: item["score"].as_f64().unwrap(),
                })
                .collect();
            sort_decisions(&mut decisions);
            let got: Vec<usize> = decisions.iter().map(|decision| decision.loser).collect();
            let want: Vec<usize> = row["order"]
                .as_array()
                .unwrap()
                .iter()
                .map(|at| at.as_u64().unwrap() as usize)
                .collect();
            assert_eq!(got, want, "{row}");
        }
    }
}
