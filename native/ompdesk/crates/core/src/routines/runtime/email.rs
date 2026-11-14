use std::sync::Arc;

use serde_json::{Value, json};

use super::{Config, Services, Sink, wait};
use crate::fs::order::{is_js_space, js_trim};
use crate::routines::{
    imap::{self, MailCursor, MailMessage},
    text::clip,
};
use crate::server::Scope;

pub(super) struct Options {
    pub account: String,
    pub from: Option<String>,
    pub subject: Option<String>,
    pub to: Option<String>,
}

fn integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

pub(super) async fn run<S: Services, C: Sink>(
    services: Arc<S>,
    options: Options,
    mark: Option<Value>,
    sink: C,
    scope: &Scope,
    config: Config,
) {
    let mut cursor = mark.as_ref().and_then(|mark| {
        Some((
            mark["accountId"].as_str()?.to_owned(),
            MailCursor {
                validity: integer(&mark["validity"])?,
                uid: integer(&mark["uid"])?,
            },
        ))
    });
    let key = format!("email {}: read", options.account);
    loop {
        if scope.cancelled() || !sink.current() {
            return;
        }
        let account = tokio::select! { biased; _ = scope.on_cancel() => return, account = services.mailbox(&options.account) => account };
        let result = match account {
            Ok(Some(account)) => {
                let known = cursor
                    .as_ref()
                    .filter(|(id, _)| id == &account.id)
                    .map(|(_, cursor)| *cursor);
                match imap::read_mailbox(&account, known, scope).await {
                    Ok(read) => {
                        cursor = Some((account.id.clone(), read.cursor));
                        if scope.cancelled() || !sink.current() {
                            return;
                        }
                        let lines = if known.is_some() {
                            read.messages
                                .iter()
                                .filter(|message| wanted(message, &account.address, &options))
                                .map(|message| describe(message, &account.label))
                                .collect()
                        } else {
                            Vec::new()
                        };
                        sink.failure(&key, None);
                        sink.publish(Some(json!({"accountId":account.id,"validity":read.cursor.validity,"uid":read.cursor.uid})), &lines);
                        Ok(())
                    }
                    Err(error) => Err(error.message),
                }
            }
            Ok(None) => Err(
                "no mail account has that name or id (Settings › Schedules › Email accounts)"
                    .into(),
            ),
            Err(error) => Err(error.message),
        };
        if scope.cancelled() || !sink.current() {
            return;
        }
        if let Err(error) = result {
            sink.failure(&key, Some(&error));
        }
        if !wait(scope, config.email_poll).await {
            return;
        }
    }
}

fn wanted(message: &MailMessage, own_address: &str, options: &Options) -> bool {
    let headers = &message.headers;
    let field = |name: &str| headers.get(name).map_or("", String::as_str);
    let auto = js_trim(field("auto-submitted")).to_lowercase();
    if !auto.is_empty() && auto != "no" {
        return false;
    }
    let from = field("from").to_lowercase();
    let own = js_trim(own_address).to_lowercase();
    if !own.is_empty()
        && !field("in-reply-to").is_empty()
        && addresses(&from).any(|address| address == own)
    {
        return false;
    }
    let has = |text: &str, needle: Option<&str>| {
        needle.is_none_or(|needle| {
            text.to_lowercase()
                .contains(&js_trim(needle).to_lowercase())
        })
    };
    let recipients = [field("to"), field("cc"), field("delivered-to")]
        .into_iter()
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    has(field("from"), options.from.as_deref())
        && has(field("subject"), options.subject.as_deref())
        && has(&recipients, options.to.as_deref())
}

fn addresses(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(|c| is_js_space(c) || matches!(c, '<' | '>' | '"' | ',' | ';'))
        .filter(|part| {
            part.find('@')
                .is_some_and(|at| at > 0 && at + 1 < part.len())
        })
}

fn describe(message: &MailMessage, label: &str) -> String {
    let field = |name: &str| clip(message.headers.get(name).map_or("", String::as_str), 160);
    let subject = field("subject");
    let from = field("from");
    let to = field("to");
    let date = field("date");
    let text = clip(&message.snippet, 600);
    format!(
        "New mail in {label} from {} to {}: \"{}\"{}{}",
        if from.is_empty() {
            "an unknown sender"
        } else {
            &from
        },
        if to.is_empty() { "(no To)" } else { &to },
        if subject.is_empty() {
            "(no subject)"
        } else {
            &subject
        },
        if message
            .headers
            .get("date")
            .is_some_and(|date| !date.is_empty())
        {
            format!(" ({date})")
        } else {
            String::new()
        },
        if text.is_empty() {
            String::new()
        } else {
            format!(". It begins: {text}")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[test]
    fn preserves_the_mail_filter_and_loop_guard_contract() {
        let options = Options {
            account: "Work".into(),
            from: Some("ann@".into()),
            subject: Some("deploy".into()),
            to: Some("owner+ci@".into()),
        };
        let mut message = MailMessage {
            uid: 1,
            headers: BTreeMap::from([
                ("from".into(), "Ann <ANN@example.invalid>".into()),
                ("cc".into(), "Owner+Ci@example.invalid".into()),
                ("subject".into(), "Deploy v2 please".into()),
            ]),
            snippet: "hello".into(),
        };
        assert!(wanted(&message, "owner@example.invalid", &options));
        message
            .headers
            .insert("auto-submitted".into(), " auto-replied ".into());
        assert!(!wanted(&message, "owner@example.invalid", &options));
        message.headers.remove("auto-submitted");
        message
            .headers
            .insert("from".into(), "Owner <OWNER@example.invalid>".into());
        message
            .headers
            .insert("in-reply-to".into(), "<earlier@example.invalid>".into());
        let all = Options {
            account: "Work".into(),
            from: None,
            subject: None,
            to: None,
        };
        assert!(!wanted(&message, " owner@example.invalid ", &all));
        message.headers.remove("in-reply-to");
        assert!(wanted(&message, "owner@example.invalid", &all));
        assert!(describe(&message, "Work").contains("It begins: hello"));
    }
}
