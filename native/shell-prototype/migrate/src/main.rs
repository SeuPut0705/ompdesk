//! `migrate-check <userData> <webviewDir>`: runs the migrate step alone and prints its log lines.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(user_data), Some(webview)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: migrate-check <userData> <webviewDir>");
        std::process::exit(2);
    };
    shell_migrate::run(user_data.as_ref(), webview.as_ref(), &mut |event, fields| {
        println!("{}", serde_json::json!({ "event": event, "fields": fields }));
    });
}
