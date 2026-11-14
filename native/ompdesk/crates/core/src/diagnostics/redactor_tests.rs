use serde::Deserialize;

use super::redactor::{redact_diagnostics_file, redact_diagnostics_text, redact_secret_text};

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    operation: Operation,
    file: Option<String>,
    input: String,
    output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Secret,
    Text,
    File,
}

#[test]
fn matches_captured_typescript_redactor() {
    let corpus: Corpus = serde_json::from_str(include_str!("redactor-captured.json"))
        .expect("captured redactor corpus must be valid JSON");
    for case in corpus.cases {
        let actual = match case.operation {
            Operation::Secret => redact_secret_text(&case.input),
            Operation::Text => redact_diagnostics_text(&case.input),
            Operation::File => redact_diagnostics_file(
                case.file.as_deref().expect("file operation requires a filename"),
                &case.input,
            ),
        };
        assert_eq!(actual, case.output, "captured case: {}", case.name);
    }
}
