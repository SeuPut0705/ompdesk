use super::plan::{Model, Request, Role};
use crate::control::js::number;

fn purpose(role: &Role) -> String {
    match role.id.as_str() {
        "default" => "The main model: it answers every conversation turn and does the coding work unless another role takes over.",
        "smol" => "Fast, cheap model for lightweight work (quick lookups, small edits, the model `prewalk` hands implementation to). Speed and price matter more than depth.",
        "slow" => "Thinking model for hard reasoning and thorough analysis when the user switches to it. When no advisor model is set, the advisor uses this role's model.",
        "vision" => "Reads images when the active model cannot; needs image input.",
        "plan" => "Architect model for plan mode: explores and writes the implementation plan before any edit.",
        "commit" => "Writes commit messages and changelog entries (`omp commit`). Short, cheap output is enough.",
        "tiny" => "Smallest, cheapest model for trivial background tasks such as session titles. Falls back to the Fast role.",
        "task" => "Runs subagents spawned by the task tool; they do delegated coding work in parallel.",
        "advisor" => "Second-opinion reviewer: passively reviews every turn of the main agent and injects notes (concerns, blockers). Ideally a strong model from a different vendor than the default model, so it catches different mistakes. It only runs while the advisor is enabled.",
        _ => return format!("{} ({} role)", role.name, role.section.as_deref().unwrap_or("chat")),
    }.to_owned()
}

fn round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor < 0.5 {
        floor
    } else {
        floor + 1.0
    }
}

fn fixed2(value: f64) -> f64 {
    if value >= 1e21 {
        return value;
    }
    // As upkeep::engine::fixed4 does: only exact binary ties differ from Rust's decimal formatting.
    let eighths = value * 8.0;
    if eighths.fract() == 0.0 && eighths % 2.0 == 1.0 {
        round(value * 100.0) / 100.0
    } else {
        format!("{value:.2}").parse().unwrap_or(value)
    }
}
fn tokens(value: f64) -> String {
    if value >= 1_000_000.0 {
        let rounded = fixed2(value / 1_000_000.0);
        format!("{}M", number(rounded))
    } else if value >= 1_000.0 {
        format!("{}K", number(round(value / 1_000.0)))
    } else {
        number(value)
    }
}

fn describe_model(model: &Model) -> String {
    let mut facts = vec![format!("provider {}", model.provider)];
    if let Some(name) = &model.name
        && !name.is_empty()
        && Some(name.as_str()) != model.selector.split_once('/').map(|(_, id)| id)
    {
        facts.push(format!("name \"{name}\""));
    }
    if let Some(context) = model.context_window
        && context != 0.0
    {
        facts.push(format!("context window {} tokens", tokens(context)));
    }
    if let Some(cost) = &model.cost
        && let (Some(input), Some(output)) = (cost.input, cost.output)
    {
        facts.push(format!(
            "${} input / ${} output per 1M tokens",
            number(input),
            number(output)
        ));
    }
    if let Some(intelligence) = model.intelligence {
        facts.push(format!(
            "catalog intelligence score {}",
            number(round(intelligence))
        ));
    }
    format!("- {} ({})", model.selector, facts.join("; "))
}

fn describe_role(role: &Role) -> String {
    format!("- {} ({}): {}", role.id, role.name, purpose(role))
}

pub fn build(request: &Request) -> String {
    let mut lines = vec![
        "You are choosing which model omp (a coding agent) uses for each of its model roles, for the user of OMPdesk.".into(),
        String::new(), "## Candidate models".into(), "Use only these models, written exactly as listed (`provider/id`):".into(),
    ];
    lines.extend(request.models.iter().map(describe_model));
    lines.push(String::new());
    lines.push(request.default_model.as_ref().map_or_else(
        || "The user has no default model set.".into(),
        |model| format!("The user's current default model is {model}."),
    ));
    lines.extend([String::new(), "## Roles".into()]);
    let groups: &[(&str, &[&str])] = &[
        ("Conversation", &["default", "slow", "smol", "plan"]),
        (
            "Agent work",
            &["task", "advisor", "commit", "tiny", "widget"],
        ),
        (
            "Input & output",
            &["vision", "image", "web", "speech", "dictation", "judge"],
        ),
    ];
    let mut listed = Vec::new();
    for (heading, ids) in groups {
        let roles: Vec<&Role> = ids
            .iter()
            .flat_map(|id| request.roles.iter().filter(move |role| role.id == *id))
            .collect();
        if roles.is_empty() {
            continue;
        }
        lines.push(format!("### {heading}"));
        lines.extend(roles.iter().map(|role| describe_role(role)));
        lines.push(String::new());
        listed.extend(roles.into_iter().map(|role| role.id.as_str()));
    }
    let other = request
        .roles
        .iter()
        .filter(|role| !listed.contains(&role.id.as_str()))
        .collect::<Vec<_>>();
    if !other.is_empty() {
        lines.push("### Other roles".into());
        lines.extend(other.into_iter().map(describe_role));
        lines.push(String::new());
    }
    lines.extend([
        "## Task".into(),
        "1. Research current public benchmarks and comparisons for exactly these models: use web_search, then read the most relevant pages. Prefer recent, reputable sources (vendor model cards, independent leaderboards such as coding and agentic benchmarks, price and speed comparisons). Do not research other models.".into(),
        "2. Decide group by group, so a group's roles fit together: within Conversation, Fast is the cheapest and quickest, Thinking the strongest, Default in between. For each role, pick the candidate that best fits its purpose, weighing capability, speed and price. Leave a role out when no candidate fits it; an omitted role keeps its current model.".into(),
        "3. Decide whether the advisor should be enabled: it is worth it when a strong candidate from a different vendor than the default model is available.".into(),
        String::new(), "## Reply".into(),
        "Reply with ONLY one JSON object: no prose before or after it, no code fence. Shape:".into(),
        "{\"assignments\":[{\"role\":\"<role id>\",\"model\":\"<provider/id>\",\"reason\":\"<one sentence>\"}],\"advisor\":{\"enable\":<true or false>,\"reason\":\"<one sentence>\"},\"sources\":[{\"title\":\"<page title>\",\"url\":\"<https URL>\"}],\"notes\":\"<optional, one or two sentences>\"}".into(),
        format!("- \"role\" is one of: {}.", request.roles.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(", ")),
        format!("- \"model\" is one of: {}.", request.models.iter().map(|m| m.selector.as_str()).collect::<Vec<_>>().join(", ")),
        "- \"sources\" lists the pages you actually used.".into(),
        format!("- Write every \"reason\" and \"notes\" in {}.", request.language.as_deref().unwrap_or("English")),
    ]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_captured_javascript_rounding_at_decimal_ties() {
        assert_eq!(tokens(1_125_000.0), "1.13M");
        assert_eq!(tokens(1_375_000.0), "1.38M");
        assert_eq!(tokens(1_325_000.0), "1.32M");
        assert_eq!(number(round(4_503_599_627_370_497.0)), "4503599627370497");
    }
}
