use super::tail;

#[test]
fn run_output_keeps_the_last_utf16_units_across_chunks() {
    let mut output = "a".repeat(16 * 1024);
    tail(&mut output, "😀z");
    assert_eq!(output, format!("{}😀z", "a".repeat(16 * 1024 - 3)));
    tail(&mut output, &"b".repeat(16 * 1024));
    assert_eq!(output, "b".repeat(16 * 1024));
}

#[test]
fn run_output_replaces_a_cut_surrogate() {
    let mut output = String::from("😀");
    tail(&mut output, &"x".repeat(16 * 1024 - 1));
    assert_eq!(output, format!("�{}", "x".repeat(16 * 1024 - 1)));
}
