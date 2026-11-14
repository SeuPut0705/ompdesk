//! Native routing of Autopilot's extension UI cards. The shell supplies the real tab's role from the coordinator;
//! a page cannot name a role. The existing bridge guard judges approval text inside that tab's stock omp.

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Parent,
    Child,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Once {
    Approve,
    ApproveOnce,
}

impl Once {
    fn label(self) -> &'static str {
        match self {
            Self::Approve => "Approve",
            Self::ApproveOnce => "Approve Once",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Card {
    Leave,
    Answer(Value),
    Check { once: Once, text: String },
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Stock's `approvalChoices` (`src/shared/tool-approval.ts`): only a recognized card may receive an automatic answer.
/// The page needs its own parser; native regression cases cover remembering and malformed grants too.
fn once_choice(request: &Value) -> Option<Once> {
    if text(request, "method") != Some("select")
        || !text(request, "title")?.starts_with("Allow tool: ")
    {
        return None;
    }
    let (deny, rest) = request.get("options")?.as_array()?.split_last()?;
    if deny.as_str() != Some("Deny") {
        return None;
    }
    let rest = if rest.last().and_then(Value::as_str).is_some_and(|label| {
        label.starts_with("Approve ")
            && label.ends_with(" for this session")
            && label.len() > "Approve  for this session".len()
    }) {
        &rest[..rest.len() - 1]
    } else {
        rest
    };
    let (once_value, grants) = rest.split_last()?;
    let once = if grants.is_empty() {
        Once::Approve
    } else {
        Once::ApproveOnce
    };
    if grants.len() % 2 != 0 || once.label() != once_value.as_str()? {
        return None;
    }
    let count = grants.len() / 2;
    for index in 0..count {
        let grant = grants[index].as_str()?;
        let valid = matches!(grant, "Approve File" | "Approve")
            || grant
                .strip_prefix("Approve Directory: ")
                .is_some_and(|folder| !folder.is_empty());
        if !valid || grants[index + count].as_str()?.strip_prefix("Always ") != Some(grant) {
            return None;
        }
    }
    Some(once)
}

/// The identity is copied from the actual sidecar request, never from the guard's reply.
pub fn approval_response(request: &Value, once: Once, reason: Option<&str>) -> Value {
    json!({"type": "extension_ui_response", "id": request["id"], "value": if reason.is_some() { "Deny" } else { once.label() }})
}

fn question_response(request: &Value) -> Value {
    let declined =
        || json!({"type": "extension_ui_response", "id": request["id"], "cancelled": true});
    if text(request, "method") != Some("ask") {
        return declined();
    }
    let Some(questions) = request.get("questions").and_then(Value::as_array) else {
        return declined();
    };
    let mut answers = Vec::with_capacity(questions.len());
    for question in questions {
        let Some(index) = question
            .get("recommended")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
        else {
            return declined();
        };
        let Some(label) = question
            .get("options")
            .and_then(Value::as_array)
            .and_then(|options| options.get(index))
            .and_then(|option| option.get("label"))
        else {
            return declined();
        };
        answers.push(json!({"id": question["id"], "selectedOptions": [label]}));
    }
    if answers.is_empty() {
        declined()
    } else {
        json!({"type": "extension_ui_response", "id": request["id"], "answers": answers})
    }
}

/// Classification cannot authorize a tool. `Check` always requires the live session's existing bridge guard first.
pub fn classify(request: &Value, role: Role) -> Card {
    if let Some(once) = once_choice(request) {
        let title = text(request, "title").unwrap_or_default();
        let mut card = title
            .strip_prefix("Allow tool:")
            .unwrap_or(title)
            .trim_start_matches(crate::fs::order::is_js_space)
            .to_owned();
        if let Some(details) = request.get("optionDetails").and_then(Value::as_array) {
            for detail in details {
                if let Some(description) =
                    text(detail, "description").filter(|text| !text.is_empty())
                {
                    card.push('\n');
                    card.push_str(description);
                }
            }
        }
        return Card::Check { once, text: card };
    }
    if role == Role::Child
        || text(request, "title").is_some_and(|title| title.starts_with("[OMPdesk] "))
    {
        return Card::Leave;
    }
    match text(request, "method") {
        Some("ask" | "confirm" | "select" | "editor") => Card::Answer(question_response(request)),
        _ => Card::Leave,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(options: Value) -> Value {
        json!({"type": "extension_ui_request", "id": "r1", "method": "select", "title": "Allow tool: bash\ngit status", "options": options})
    }

    #[test]
    fn only_once_choices_are_sent_to_the_guard_not_remembering_grants() {
        for options in [
            json!(["Approve", "Deny"]),
            json!(["Approve", "Approve bash for this session", "Deny"]),
        ] {
            assert_eq!(
                classify(&approval(options), Role::Parent),
                Card::Check {
                    once: Once::Approve,
                    text: "bash\ngit status".into()
                }
            );
        }
        let card = approval(json!([
            "Approve Directory: /wt/src",
            "Approve File",
            "Always Approve Directory: /wt/src",
            "Always Approve File",
            "Approve Once",
            "Deny"
        ]));
        assert_eq!(
            classify(&card, Role::Child),
            Card::Check {
                once: Once::ApproveOnce,
                text: "bash\ngit status".into()
            }
        );
        assert_eq!(
            approval_response(&card, Once::ApproveOnce, None)["value"],
            "Approve Once"
        );
        assert_eq!(
            approval_response(&card, Once::ApproveOnce, Some("destructive git"))["value"],
            "Deny"
        );
    }

    #[test]
    fn malformed_grants_never_become_an_approval() {
        for options in [
            json!(["Approve Once", "Deny"]),
            json!([
                "Approve File",
                "Always Approve Directory: /wt",
                "Approve Once",
                "Deny"
            ]),
            json!([
                "Approve Directory: ",
                "Always Approve Directory: ",
                "Approve Once",
                "Deny"
            ]),
            json!(["Approve", "Approve  for this session", "Deny"]),
            json!(["Approve", "Yes"]),
            json!(["Approve", null, "Deny"]),
        ] {
            assert_eq!(
                classify(&approval(options), Role::Parent),
                Card::Answer(
                    json!({"type": "extension_ui_response", "id": "r1", "cancelled": true})
                )
            );
        }
    }

    #[test]
    fn the_guard_receives_option_descriptions_as_well_as_the_title() {
        let mut card = approval(json!(["Approve", "Deny"]));
        card["optionDetails"] =
            json!([{"description": "git reset --hard HEAD~3"}, {}, {"description": ""}]);
        assert_eq!(
            classify(&card, Role::Parent),
            Card::Check {
                once: Once::Approve,
                text: "bash\ngit status\ngit reset --hard HEAD~3".into()
            }
        );
    }

    #[test]
    fn child_questions_and_control_cards_and_sign_in_traffic_remain_with_the_owner() {
        let question = json!({"id": "q", "method": "confirm", "title": "Continue?"});
        assert_eq!(classify(&question, Role::Child), Card::Leave);
        for request in [
            json!({"id": "q", "method": "confirm", "title": "[OMPdesk] Stop session?"}),
            json!({"id": "q", "method": "open_url", "url": "https://example.invalid"}),
            json!({"id": "q", "method": "notify", "message": "hi"}),
            json!({"id": "q", "method": "input", "title": "Account"}),
        ] {
            assert_eq!(classify(&request, Role::Parent), Card::Leave);
        }
    }

    #[test]
    fn asks_require_a_recommendation_for_every_question() {
        let mut request = json!({"id": "q", "method": "ask", "questions": [
            {"id": "a", "options": [{"label": "One"}, {"label": "Two"}], "recommended": 1},
            {"id": "b", "options": [{"label": "Yes"}]}
        ]});
        assert_eq!(
            classify(&request, Role::Parent),
            Card::Answer(json!({"type": "extension_ui_response", "id": "q", "cancelled": true}))
        );
        request["questions"].as_array_mut().unwrap().pop();
        assert_eq!(
            classify(&request, Role::Parent),
            Card::Answer(
                json!({"type": "extension_ui_response", "id": "q", "answers": [{"id": "a", "selectedOptions": ["Two"]}]})
            )
        );
    }
}
