//! What a failed turn's message and a provider's usage reports say: the classifiers turn resume judges a failure by
//! (were the regexes of `src/main/turn-resume.ts`) and the quota rules (`src/shared/quota-reset.ts`, which the page's
//! error card keeps reading in TypeScript: that file is the one second copy, held to this one by the same captured
//! rows in both languages, `classifiers-captured.json`).

use serde_json::Value;

use super::jsre::{Lazy, Regex};

/// A provider/transport failure rather than the model's or the account's: a subset of stock's retryable-error
/// pattern naming the transport. Server errors, rate limits and quotas are not "no connection".
static NETWORK_ERROR: Lazy = Lazy::new(|| {
    Regex::new(
        r"network.?error|connection.?(error|refused|lost|reset|closed)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|ETIMEDOUT|socket hang up|socket connection was closed|reset before headers|websocket.?(closed|error)|stream ended before|ended without|unable to connect|timed? out|terminated|offline|internet",
        true,
    )
});

pub fn is_network_error(message: Option<&str>) -> bool {
    message.is_some_and(|message| NETWORK_ERROR.test(message))
}

/// A failure to connect at all (a failed lookup, a refused or unroutable connection): the network failures a
/// reachability probe can tell from a provider's own trouble. A socket dropped mid-reply is not one of them.
static CONNECT_ERROR: Lazy = Lazy::new(|| {
    Regex::new(
        r"getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ENETDOWN|EHOSTUNREACH|connection.?refused|unable to connect",
        true,
    )
});

/// The host it names: stock's "Couldn't reach <host> (getaddrinfo ENOTFOUND)", Node's "getaddrinfo ENOTFOUND <host>",
/// or a URL's.
static CONNECT_HOST: Lazy = Lazy::new(|| {
    Regex::new(
        r"couldn't reach ([a-z0-9.-]+)|(?:ENOTFOUND|EAI_AGAIN) ([a-z0-9.-]+)|https?:\/\/([a-z0-9.-]+)",
        true,
    )
});

/// The host a failed connection could not reach; `Some("")` when it names none; `None` when the failure is not a
/// failed connection.
pub fn connect_failure_host(message: Option<&str>) -> Option<String> {
    let message = message?;
    if !CONNECT_ERROR.test(message) {
        return None;
    }
    let host = CONNECT_HOST
        .exec(message)
        .and_then(|groups| groups.into_iter().skip(1).flatten().next())
        .unwrap_or_default();
    let valid = host.split('.').count() >= 2 && host.split('.').all(is_label);
    Some(if valid {
        host.to_lowercase()
    } else {
        String::new()
    })
}

fn is_label(label: &str) -> bool {
    !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Stock's `RETRYABLE_PROVIDER_ERROR_PATTERN` with its rate-limit wordings removed (those are never transient) and
/// the bare status codes word-bounded, so "500000 tokens" never reads as an HTTP 500.
static RETRYABLE_ERROR: Lazy = Lazy::new(|| {
    Regex::new(
        r"overloaded|\b(?:500|502|503|504|520|524|529)\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request",
        true,
    )
});

/// Failures no retry of ours fixes: sign-in and permission, a request the provider rejected, a context that does not
/// fit, certificates.
static NEVER_RETRIED: Lazy = Lazy::new(|| {
    Regex::new(
        r"\b(?:401|403|400)\b|invalid[ _-]?(?:x-)?api[ _-]?key|unauthori[sz]ed|\bforbidden\b|authenticat|not logged in|log ?in required|no api key|token (?:has )?expired|bad request|invalid[ _-]?request|prompt is too long|context[ _-](?:length|window)|maximum context|too many tokens|context_length_exceeded|input is too long|exceeds? the (?:model'?s? )?(?:context|maximum)|certificate|self[- ]signed|unable to verify the first|unable_to_(?:verify|get)_issuer|\bssl\b|\btls\b|err_tls|cert_has_expired|depth_zero_self_signed|err_cert",
        true,
    )
});

/// A provider's rate limit, quota or usage limit by its wording: what both waits take up.
static LIMIT_WORDING: Lazy = Lazy::new(|| {
    Regex::new(
        r"\b429\b|rate[ _.-]?limit|too many requests|quota|usage limit|GoUsageLimitError|FreeUsageLimitError|ResourceExhausted",
        true,
    )
});

pub fn is_limit_wording(message: Option<&str>) -> bool {
    message.is_some_and(|message| LIMIT_WORDING.test(message))
}

/// An account out of money, which adding money clears and waiting never does: stock's billing cap plus the billing
/// wordings the scheduled retry already refused.
static BILLING_CAP: Lazy = Lazy::new(|| {
    Regex::new(
        r"\b402\b|\bout of credit|\badd (?:more )?credit|\btop ?up\b|insufficient|available balance|out of budget|billing|\b(?:exceed\w*|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b|\busage_pricing_required\b|\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b|spend(?:ing)?[\s_-]?(?:limit|cap)\b|\busage credits are required\b|\bcredits_required\b",
        true,
    )
});

pub fn is_billing_cap(message: Option<&str>) -> bool {
    message.is_some_and(|message| BILLING_CAP.test(message))
}

/// A failure that stock's own retries gave up on but that a later attempt may well clear: server errors, overload,
/// timeouts, dropped connections. Never a limit (the limit wait owns those) nor an account out of money.
pub fn is_transient_error(message: Option<&str>) -> bool {
    let Some(message) = message.filter(|message| !message.is_empty()) else {
        return false;
    };
    if NEVER_RETRIED.test(message)
        || is_limit_wording(Some(message))
        || is_billing_cap(Some(message))
    {
        return false;
    }
    RETRYABLE_ERROR.test(message) || is_network_error(Some(message))
}

/// A provider's rate limit or usage limit that passes with time: the turn is tried again once it is expected gone.
/// Never an account out of money, nor a failure of `NEVER_RETRIED`.
pub fn is_limit_error(message: Option<&str>) -> bool {
    is_limit_wording(message)
        && !is_billing_cap(message)
        && !NEVER_RETRIED.test(message.unwrap_or(""))
}

/// Stock's hint on a failed reply (pi-ai appends ` retry-after-ms=<n>` from the provider's headers).
static RETRY_AFTER: Lazy = Lazy::new(|| Regex::new(r"\bretry-after-ms\s*[:=]\s*(\d+)\b", true));

/// How long after the failure the provider said to wait, in ms; `None` when the reply carries no such hint.
pub fn retry_after_ms(message: Option<&str>) -> Option<f64> {
    let digits = RETRY_AFTER.exec(message.unwrap_or(""))?.get(1)?.clone()?;
    let ms: f64 = digits.parse().ok()?;
    (ms.is_finite() && ms > 0.0).then_some(ms)
}

/// When the provider's usage limit lets `provider` run again: stock may rotate to any of the provider's accounts, so
/// the first account to reset frees the session. Unknown (`None`) while any account is not limited, or no report names
/// a reset. `reports` are stock's usage reports as main read them; only `provider` and `resetAt` count.
pub fn quota_reset_at(reports: &[Value], provider: Option<&str>, now: f64) -> Option<f64> {
    let accounts: Vec<&Value> = reports
        .iter()
        .filter(|report| match (report.get("provider"), provider) {
            (None, None) => true,
            (Some(Value::String(found)), Some(wanted)) => found == wanted,
            _ => false,
        })
        .collect();
    if accounts.is_empty() {
        return None;
    }
    let mut soonest: Option<f64> = None;
    for account in accounts {
        let reset = account.get("resetAt").and_then(Value::as_f64);
        let reset = reset.filter(|reset| *reset > now)?;
        soonest = Some(soonest.map_or(reset, |current| current.min(reset)));
    }
    soonest
}

/// When a turn the provider's limit stopped is tried again: that reset, else `fallback_ms` from now.
pub fn quota_wait_until(
    reports: &[Value],
    provider: Option<&str>,
    now: f64,
    fallback_ms: f64,
) -> f64 {
    quota_reset_at(reports, provider, now).unwrap_or(now + fallback_ms)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Rows captured from the TypeScript (`isNetworkError`, `isTransientError`, `isLimitError`,
    /// `connectFailureHost`, `retryAfterMs`, `quotaResetAt`) on 13 Nov 2026; `src/shared/quota-reset.test.ts` runs the
    /// TypeScript copy of the quota rules over the same file.
    #[test]
    fn answers_as_the_typescript_did_on_the_captured_rows() {
        let rows: Value =
            serde_json::from_str(include_str!("classifiers-captured.json")).expect("json");
        let rows = rows.as_array().expect("array");
        assert!(rows.len() > 60, "{} rows", rows.len());
        for row in rows {
            let message = row["message"].as_str();
            let at = format!("{row}");
            assert_eq!(
                is_network_error(message),
                row["network"].as_bool().expect("network"),
                "network: {at}"
            );
            assert_eq!(
                is_transient_error(message),
                row["transient"].as_bool().expect("transient"),
                "transient: {at}"
            );
            assert_eq!(
                is_limit_error(message),
                row["limit"].as_bool().expect("limit"),
                "limit: {at}"
            );
            assert_eq!(
                is_billing_cap(message),
                row["billing"].as_bool().expect("billing"),
                "billing: {at}"
            );
            assert_eq!(
                connect_failure_host(message),
                row["host"].as_str().map(str::to_owned),
                "host: {at}"
            );
            assert_eq!(
                retry_after_ms(message),
                row["retryAfter"].as_f64(),
                "retryAfter: {at}"
            );
        }
    }

    #[test]
    fn a_reset_is_known_only_when_every_account_names_one_ahead() {
        let reports = [
            json!({"provider": "anthropic", "resetAt": 500}),
            json!({"provider": "anthropic", "resetAt": 300}),
            json!({"provider": "openai"}),
        ];
        assert_eq!(
            quota_reset_at(&reports, Some("anthropic"), 100.0),
            Some(300.0)
        );
        assert_eq!(quota_reset_at(&reports, Some("anthropic"), 400.0), None);
        assert_eq!(quota_reset_at(&reports, Some("openai"), 100.0), None);
        assert_eq!(quota_reset_at(&reports, Some("other"), 100.0), None);
        assert_eq!(quota_reset_at(&reports, None, 100.0), None);
        assert_eq!(
            quota_wait_until(&reports, Some("other"), 100.0, 900.0),
            1000.0
        );
    }
}
