use serde::Deserialize;
use serde_json::Value;

use super::prompt_policy;
use crate::json::whole_surrogates;

#[derive(Deserialize)]
struct Case {
    text: String,
    #[serde(rename = "sessionName")]
    session_name: Option<String>,
    expected: Value,
}

#[test]
fn native_policy_preserves_the_original_prompt_contract() {
    let cases: Vec<Case> =
        serde_json::from_str(&whole_surrogates(include_str!("prompt-captured.json"))).unwrap();
    for case in cases {
        let fact = prompt_policy::facts(&case.text, case.session_name.as_deref());
        let actual: Value = serde_json::from_str(&whole_surrogates(&fact.json())).unwrap();
        assert_eq!(actual, case.expected, "{}", case.text);
    }
}
