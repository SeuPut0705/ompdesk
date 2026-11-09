//! `ai-memory-eval` — offline evaluation harnesses for ai-memory.
//!
//! Four subcommands:
//!
//! - `ab` — live A/B comparison of two LLM providers on the production
//!   consolidation prompt, with literal-fidelity scoring (see [`ab`],
//!   [`fidelity`] and `evals/README.md`).
//! - `projection` — the zero-LLM half of that scoring: which fixture facts
//!   and literal tokens the observation projection lets into the prompt.
//! - `retrieval` — LongMemEval retrieval benchmark driven end-to-end
//!   through a real `ai-memory serve` subprocess: hook-shaped ingestion,
//!   real search stack, R@k / hit@k per question category (see
//!   [`retrieval`] and `docs/benchmarks/`).
//! - `dream` — the B2 dream pass on vs off on a snapshot of a real store,
//!   merging through omp's cheap model role: recall before and after, and
//!   whether every merged source's facts survived (see [`dream`]).

mod ab;
mod dream;
mod fidelity;
mod generate;
mod projection;
mod retrieval;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "ai-memory-eval",
    about = "Evaluation harnesses for ai-memory (LLM A/B + retrieval benchmark)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Live A/B harness comparing two LLM providers on the ai-memory
    /// consolidation prompt.
    Ab(Box<ab::AbArgs>),
    /// Zero-LLM: which facts the consolidation prompt's observation
    /// projection keeps, per fixture.
    Projection(projection::ProjectionArgs),
    /// LongMemEval retrieval benchmark through the real server stack.
    Retrieval(Box<retrieval::RetrievalArgs>),
    /// Dream pass on vs off on a snapshot of a real store (real omp calls).
    Dream(Box<dream::DreamArgs>),
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ai_memory_eval=info,warn".into()),
        )
        .init();

    match Cli::parse().command {
        Command::Ab(args) => ab::run(*args).await,
        Command::Projection(args) => projection::run(args),
        Command::Retrieval(args) => retrieval::run(*args).await,
        Command::Dream(args) => dream::run(*args).await,
    }
}
