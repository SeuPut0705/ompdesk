//! Pure parts of `net.*` (PROTOCOL.md §10): parameter parsing, request flags, Chromium's `net::ERR_…` names, status
//! texts, the head and endpoint JSON. No CEF in here (the glue is `src/net.rs`), so `cargo test` covers it.

use std::net::IpAddr;

use serde_json::{Value, json};

/// How a fetch treats a 3xx (Fetch's `redirect`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redirect {
    Follow,
    Manual,
    Error,
}

/// Fetch's `credentials`: whether cookies go with the request and are kept from the response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Credentials {
    Include,
    Omit,
    SameOrigin,
}

/// Fetch's `cache`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheMode {
    Default,
    NoStore,
    Reload,
    NoCache,
    ForceCache,
    OnlyIfCached,
}

/// `net.fetch`'s parameters, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchParams {
    pub req_id: u64,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub has_body: bool,
    pub redirect: Redirect,
    pub credentials: Credentials,
    pub cache: CacheMode,
    pub partition: String,
    pub bypass_custom_protocol_handlers: bool,
}

/// Request headers Chromium computes itself; sending the caller's copy would duplicate or contradict them.
const OWN_HEADERS: [&str; 4] = ["content-length", "host", "connection", "transfer-encoding"];

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

/// Reads and checks `net.fetch`'s params; the error is the `invalid` answer's message.
pub fn parse_fetch(params: &Value) -> Result<FetchParams, String> {
    let req_id = params
        .get("reqId")
        .and_then(Value::as_u64)
        .ok_or("net.fetch needs a reqId")?;
    let url = text(params, "url")
        .filter(|u| !u.is_empty())
        .ok_or("net.fetch needs a url")?
        .to_string();
    let method = text(params, "method")
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("GET")
        .to_string();
    let mut headers = Vec::new();
    if let Some(list) = params.get("headers") {
        let list = list
            .as_array()
            .ok_or("net.fetch headers must be a list of [name, value]")?;
        for pair in list {
            let (Some(name), Some(value)) = (
                pair.get(0).and_then(Value::as_str),
                pair.get(1).and_then(Value::as_str),
            ) else {
                return Err("net.fetch headers must be a list of [name, value]".into());
            };
            if name.is_empty() || OWN_HEADERS.iter().any(|own| name.eq_ignore_ascii_case(own)) {
                continue;
            }
            headers.push((name.to_string(), value.to_string()));
        }
    }
    let redirect = match text(params, "redirect") {
        None | Some("follow") => Redirect::Follow,
        Some("manual") => Redirect::Manual,
        Some("error") => Redirect::Error,
        Some(other) => {
            return Err(format!(
                "net.fetch redirect {other:?} is not follow, manual or error"
            ));
        }
    };
    let credentials = match text(params, "credentials") {
        None | Some("include") => Credentials::Include,
        Some("omit") => Credentials::Omit,
        Some("same-origin") => Credentials::SameOrigin,
        Some(other) => {
            return Err(format!(
                "net.fetch credentials {other:?} is not include, omit or same-origin"
            ));
        }
    };
    let cache = match text(params, "cache") {
        None | Some("default") => CacheMode::Default,
        Some("no-store") => CacheMode::NoStore,
        Some("reload") => CacheMode::Reload,
        Some("no-cache") => CacheMode::NoCache,
        Some("force-cache") => CacheMode::ForceCache,
        Some("only-if-cached") => CacheMode::OnlyIfCached,
        Some(other) => {
            return Err(format!(
                "net.fetch cache {other:?} is not a fetch cache mode"
            ));
        }
    };
    Ok(FetchParams {
        req_id,
        url,
        method,
        headers,
        has_body: params
            .get("hasBody")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        redirect,
        credentials,
        cache,
        partition: text(params, "partition").unwrap_or("").to_string(),
        bypass_custom_protocol_handlers: params
            .get("bypassCustomProtocolHandlers")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Which `UR_FLAG_*` bits a fetch sets (the glue maps them to CEF's constants).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UrlFlags {
    pub skip_cache: bool,
    pub only_from_cache: bool,
    pub disable_cache: bool,
    pub allow_stored_credentials: bool,
    pub stop_on_redirect: bool,
}

impl FetchParams {
    pub fn url_flags(&self) -> UrlFlags {
        UrlFlags {
            skip_cache: matches!(self.cache, CacheMode::Reload | CacheMode::NoCache),
            only_from_cache: self.cache == CacheMode::OnlyIfCached,
            disable_cache: self.cache == CacheMode::NoStore,
            allow_stored_credentials: self.credentials != Credentials::Omit,
            stop_on_redirect: self.redirect != Redirect::Follow,
        }
    }
}

/// The scheme of `url` (lower case), when it has the shape `scheme:`.
pub fn url_scheme(url: &str) -> Option<String> {
    let end = url.find(':')?;
    let scheme = &url[..end];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
    .then(|| scheme.to_ascii_lowercase())
}

/// The `net::ERR_…` text a request that cannot even start fails with, or `None` when it may go ahead. With
/// `bypassCustomProtocolHandlers` only the schemes Chromium's network stack serves itself are left.
pub fn refuse_url(url: &str, bypass_custom_protocol_handlers: bool) -> Option<String> {
    let Some(scheme) = url_scheme(url) else {
        return Some(error_text(-300));
    };
    if bypass_custom_protocol_handlers
        && !matches!(
            scheme.as_str(),
            "http"
                | "https"
                | "ws"
                | "wss"
                | "ftp"
                | "file"
                | "data"
                | "blob"
                | "about"
                | "filesystem"
        )
    {
        return Some(error_text(-302));
    }
    None
}

/// Chromium's HTTP redirect definition: one of these statuses with a `Location`.
pub fn is_redirect(status: i32, has_location: bool) -> bool {
    has_location && matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// The standard reason phrase, for a response whose protocol (HTTP/2) carried none.
pub fn reason_phrase(status: i32) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        412 => "Precondition Failed",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        418 => "I'm a teapot",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}

fn without_fragment(url: &str) -> &str {
    url.split_once('#').map_or(url, |(base, _)| base)
}

/// Whether the response came from a different URL than the request (a redirect was followed). An empty final URL
/// (CEF did not say) counts as not redirected.
pub fn redirected(requested: &str, final_url: &str) -> bool {
    !final_url.is_empty() && without_fragment(requested) != without_fragment(final_url)
}

/// CEF's header multimap (`name → [values]`) as the wire's `[[name, value]]`: one pair per value, so several
/// `Set-Cookie` lines stay several.
pub fn header_pairs(map: Vec<(String, Vec<String>)>) -> Vec<(String, String)> {
    map.into_iter()
        .flat_map(|(name, values)| values.into_iter().map(move |value| (name.clone(), value)))
        .filter(|(name, _)| !name.is_empty())
        .collect()
}

/// The answer to `net.fetch`: the head of the response.
pub fn head_json(
    status: i32,
    status_text: &str,
    requested: &str,
    final_url: &str,
    headers: &[(String, String)],
) -> Value {
    let text = if status_text.is_empty() {
        reason_phrase(status)
    } else {
        status_text
    };
    let url = if final_url.is_empty() {
        requested
    } else {
        final_url
    };
    json!({
        "status": status,
        "statusText": text,
        "url": url,
        "redirected": redirected(requested, final_url),
        "headers": headers.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
    })
}

/// `net::ERR_NAME` of Chromium's error `code` (`-105` → `net::ERR_NAME_NOT_RESOLVED`); a code the table does not
/// know keeps its number.
pub fn error_text(code: i32) -> String {
    match ERROR_NAMES.binary_search_by_key(&code, |(c, _)| *c) {
        Ok(i) => format!("net::{}", ERROR_NAMES[i].1),
        Err(_) => format!("net::ERR_FAILED ({code})"),
    }
}

/// The URL `RequestContext::resolve_host` takes for a bare host name (an IPv6 literal gets its brackets).
pub fn resolve_origin(host: &str) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("http://[{host}]")
    } else {
        format!("http://{host}")
    }
}

/// `net.resolveHost`'s answer for the addresses CEF resolved; an entry that is not an IP address is left out.
pub fn endpoints_json(addresses: &[String]) -> Value {
    let endpoints: Vec<Value> = addresses
        .iter()
        .filter_map(|a| {
            let family = match a.parse::<IpAddr>().ok()? {
                IpAddr::V4(_) => "ipv4",
                IpAddr::V6(_) => "ipv6",
            };
            Some(json!({ "address": a, "family": family }))
        })
        .collect();
    json!({ "endpoints": endpoints })
}

/// Chromium's `net_error_list.h` as the cef crate names it (`cef_errorcode_t`), ascending by code.
const ERROR_NAMES: &[(i32, &str)] = &[
    (-906, "ERR_BLOB_REFERENCED_FILE_UNAVAILABLE"),
    (-905, "ERR_BLOB_REFERENCED_BLOB_BROKEN"),
    (-904, "ERR_BLOB_DEREFERENCED_WHILE_BUILDING"),
    (-903, "ERR_BLOB_SOURCE_DIED_IN_TRANSIT"),
    (-902, "ERR_BLOB_FILE_WRITE_FAILED"),
    (-901, "ERR_BLOB_OUT_OF_MEMORY"),
    (-900, "ERR_BLOB_INVALID_CONSTRUCTION_ARGUMENTS"),
    (-821, "ERR_DNS_DIRECT_ONLY"),
    (-820, "ERR_DNS_OTHER_FAILURE"),
    (-819, "ERR_DNS_REFUSED"),
    (-818, "ERR_DNS_NOT_IMPLEMENTED"),
    (-817, "ERR_DNS_SERVER_FAILURE"),
    (-816, "ERR_DNS_FORMAT_ERROR"),
    (-815, "ERR_DNS_CACHE_INVALIDATION_IN_PROGRESS"),
    (-814, "ERR_DNS_SECURE_PROBE_RECORD_INVALID"),
    (-811, "ERR_DNS_NO_MATCHING_SUPPORTED_ALPN"),
    (-810, "ERR_DNS_REQUEST_CANCELLED"),
    (-809, "ERR_DNS_NAME_HTTPS_ONLY"),
    (-808, "ERR_DNS_SECURE_RESOLVER_HOSTNAME_RESOLUTION_FAILED"),
    (-806, "ERR_DNS_SORT_ERROR"),
    (-805, "ERR_DNS_SEARCH_EMPTY"),
    (-804, "ERR_DNS_CACHE_MISS"),
    (-803, "ERR_DNS_TIMED_OUT"),
    (-801, "ERR_DNS_SERVER_REQUIRES_TCP"),
    (-800, "ERR_DNS_MALFORMED_RESPONSE"),
    (-716, "ERR_CERT_VERIFIER_CHANGED"),
    (-714, "ERR_CERT_DATABASE_CHANGED"),
    (-713, "ERR_SELF_SIGNED_CERT_GENERATION_FAILED"),
    (-712, "ERR_PRIVATE_KEY_EXPORT_FAILED"),
    (-710, "ERR_KEY_GENERATION_FAILED"),
    (-709, "ERR_PKCS12_IMPORT_UNSUPPORTED"),
    (-708, "ERR_PKCS12_IMPORT_INVALID_FILE"),
    (-707, "ERR_PKCS12_IMPORT_INVALID_MAC"),
    (-706, "ERR_IMPORT_SERVER_CERT_FAILED"),
    (-705, "ERR_IMPORT_CA_CERT_FAILED"),
    (-704, "ERR_IMPORT_CERT_ALREADY_EXISTS"),
    (-703, "ERR_IMPORT_CA_CERT_NOT_CA"),
    (-702, "ERR_PKCS12_IMPORT_FAILED"),
    (-701, "ERR_PKCS12_IMPORT_BAD_PASSWORD"),
    (-508, "ERR_HTTPENGINE_PROVIDER_IN_USE"),
    (
        -507,
        "ERR_TRUST_TOKEN_OPERATION_SUCCESS_WITHOUT_SENDING_REQUEST",
    ),
    (-506, "ERR_TRUST_TOKEN_OPERATION_FAILED"),
    (-505, "ERR_INVALID_WEB_BUNDLE"),
    (-504, "ERR_INVALID_SIGNED_EXCHANGE"),
    (-503, "ERR_ADD_USER_CERT_FAILED"),
    (-502, "ERR_NO_PRIVATE_KEY_FOR_CERT"),
    (-501, "ERR_INSECURE_RESPONSE"),
    (-414, "ERR_CACHE_COMPRESSION_FAILURE"),
    (-413, "ERR_CACHE_OPEN_OR_CREATE_FAILURE"),
    (-412, "ERR_CACHE_DOOM_FAILURE"),
    (-411, "ERR_CACHE_ENTRY_NOT_SUITABLE"),
    (-410, "ERR_CACHE_AUTH_FAILURE_AFTER_READ"),
    (-409, "ERR_CACHE_LOCK_TIMEOUT"),
    (-408, "ERR_CACHE_CHECKSUM_MISMATCH"),
    (-407, "ERR_CACHE_CHECKSUM_READ_FAILURE"),
    (-406, "ERR_CACHE_RACE"),
    (-405, "ERR_CACHE_CREATE_FAILURE"),
    (-404, "ERR_CACHE_OPEN_FAILURE"),
    (-403, "ERR_CACHE_OPERATION_NOT_SUPPORTED"),
    (-402, "ERR_CACHE_WRITE_FAILURE"),
    (-401, "ERR_CACHE_READ_FAILURE"),
    (-400, "ERR_CACHE_MISS"),
    (-388, "ERR_UNEXPECTED_CONTENT_DICTIONARY_HEADER"),
    (-387, "ERR_DICTIONARY_LOAD_FAILED"),
    (-386, "ERR_ZSTD_WINDOW_SIZE_TOO_BIG"),
    (-385, "ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS"),
    (
        -384,
        "ERR_CACHED_IP_ADDRESS_SPACE_BLOCKED_BY_LOCAL_NETWORK_ACCESS_POLICY",
    ),
    (-383, "ERR_INCONSISTENT_IP_ADDRESS_SPACE"),
    (-382, "ERR_TOO_MANY_ACCEPT_CH_RESTARTS"),
    (-381, "ERR_QUIC_GOAWAY_REQUEST_CAN_BE_RETRIED"),
    (-380, "ERR_QUIC_CERT_ROOT_NOT_KNOWN"),
    (-379, "ERR_HTTP_RESPONSE_CODE_FAILURE"),
    (-376, "ERR_HTTP2_STREAM_CLOSED"),
    (-375, "ERR_TOO_MANY_RETRIES"),
    (-372, "ERR_HTTP2_RST_STREAM_NO_ERROR_RECEIVED"),
    (-371, "ERR_CONTENT_DECODING_INIT_FAILED"),
    (-370, "ERR_INVALID_HTTP_RESPONSE"),
    (-367, "ERR_PAC_SCRIPT_TERMINATED"),
    (-366, "ERR_PROXY_HTTP_1_1_REQUIRED"),
    (-365, "ERR_HTTP_1_1_REQUIRED"),
    (-364, "ERR_PROXY_AUTH_REQUESTED_WITH_NO_CONNECTION"),
    (-363, "ERR_HTTP2_COMPRESSION_ERROR"),
    (-362, "ERR_HTTP2_FRAME_SIZE_ERROR"),
    (-361, "ERR_HTTP2_FLOW_CONTROL_ERROR"),
    (-360, "ERR_HTTP2_INADEQUATE_TRANSPORT_SECURITY"),
    (-358, "ERR_QUIC_HANDSHAKE_FAILED"),
    (-357, "ERR_RESPONSE_HEADERS_TRUNCATED"),
    (-356, "ERR_QUIC_PROTOCOL_ERROR"),
    (-355, "ERR_INCOMPLETE_CHUNKED_ENCODING"),
    (-354, "ERR_CONTENT_LENGTH_MISMATCH"),
    (-352, "ERR_HTTP2_PING_FAILED"),
    (-351, "ERR_HTTP2_SERVER_REFUSED_STREAM"),
    (-350, "ERR_RESPONSE_HEADERS_MULTIPLE_LOCATION"),
    (-349, "ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION"),
    (-348, "ERR_PAC_NOT_IN_DHCP"),
    (-347, "ERR_INCOMPLETE_HTTP2_HEADERS"),
    (-346, "ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH"),
    (-345, "ERR_RESPONSE_BODY_TOO_BIG_TO_DRAIN"),
    (-344, "ERR_UNDOCUMENTED_SECURITY_LIBRARY_STATUS"),
    (-343, "ERR_MISCONFIGURED_AUTH_ENVIRONMENT"),
    (-342, "ERR_UNEXPECTED_SECURITY_LIBRARY_STATUS"),
    (-341, "ERR_MISSING_AUTH_CREDENTIALS"),
    (-340, "ERR_ENCODING_DETECTION_FAILED"),
    (-339, "ERR_UNSUPPORTED_AUTH_SCHEME"),
    (-338, "ERR_INVALID_AUTH_CREDENTIALS"),
    (-337, "ERR_HTTP2_PROTOCOL_ERROR"),
    (-336, "ERR_NO_SUPPORTED_PROXIES"),
    (-331, "ERR_NETWORK_IO_SUSPENDED"),
    (-330, "ERR_CONTENT_DECODING_FAILED"),
    (-329, "ERR_MALFORMED_IDENTITY"),
    (-328, "ERR_REQUEST_RANGE_NOT_SATISFIABLE"),
    (-327, "ERR_PAC_SCRIPT_FAILED"),
    (-325, "ERR_RESPONSE_HEADERS_TOO_BIG"),
    (-324, "ERR_EMPTY_RESPONSE"),
    (-323, "ERR_UNEXPECTED_PROXY_AUTH"),
    (-322, "ERR_METHOD_NOT_SUPPORTED"),
    (-321, "ERR_INVALID_CHUNKED_ENCODING"),
    (-320, "ERR_INVALID_RESPONSE"),
    (-312, "ERR_UNSAFE_PORT"),
    (-311, "ERR_UNSAFE_REDIRECT"),
    (-310, "ERR_TOO_MANY_REDIRECTS"),
    (-303, "ERR_INVALID_REDIRECT"),
    (-302, "ERR_UNKNOWN_URL_SCHEME"),
    (-301, "ERR_DISALLOWED_URL_SCHEME"),
    (-300, "ERR_INVALID_URL"),
    (-220, "ERR_CERT_END"),
    (-219, "ERR_CERT_SELF_SIGNED_LOCAL_NETWORK"),
    (-217, "ERR_CERT_KNOWN_INTERCEPTION_BLOCKED"),
    (-214, "ERR_CERTIFICATE_TRANSPARENCY_REQUIRED"),
    (-213, "ERR_CERT_VALIDITY_TOO_LONG"),
    (-212, "ERR_CERT_NAME_CONSTRAINT_VIOLATION"),
    (-211, "ERR_CERT_WEAK_KEY"),
    (-210, "ERR_CERT_NON_UNIQUE_NAME"),
    (-208, "ERR_CERT_WEAK_SIGNATURE_ALGORITHM"),
    (-207, "ERR_CERT_INVALID"),
    (-206, "ERR_CERT_REVOKED"),
    (-205, "ERR_CERT_UNABLE_TO_CHECK_REVOCATION"),
    (-204, "ERR_CERT_NO_REVOCATION_MECHANISM"),
    (-203, "ERR_CERT_CONTAINS_ERRORS"),
    (-202, "ERR_CERT_AUTHORITY_INVALID"),
    (-201, "ERR_CERT_DATE_INVALID"),
    (-200, "ERR_CERT_COMMON_NAME_INVALID"),
    (-190, "ERR_MULTICAST_NOT_ALLOWED"),
    (-189, "ERR_CONTROL_MSG_TOO_BIG"),
    (-188, "ERR_PROXY_DELEGATE_CANCELED_CONNECT_RESPONSE"),
    (-187, "ERR_PROXY_DELEGATE_CANCELED_CONNECT_REQUEST"),
    (-186, "ERR_PROXY_UNABLE_TO_CONNECT_TO_DESTINATION"),
    (-184, "ERR_ECH_FALLBACK_CERTIFICATE_INVALID"),
    (-183, "ERR_ECH_NOT_NEGOTIATED"),
    (-182, "ERR_INVALID_ECH_CONFIG_LIST"),
    (-181, "ERR_SSL_KEY_USAGE_INCOMPATIBLE"),
    (-180, "ERR_TLS13_DOWNGRADE_DETECTED"),
    (-179, "ERR_WRONG_VERSION_ON_EARLY_DATA"),
    (-178, "ERR_EARLY_DATA_REJECTED"),
    (-177, "ERR_SSL_CLIENT_AUTH_NO_COMMON_ALGORITHMS"),
    (-176, "ERR_NO_BUFFER_SPACE"),
    (-174, "ERR_READ_IF_READY_NOT_IMPLEMENTED"),
    (-173, "ERR_WS_UPGRADE"),
    (-172, "ERR_SSL_OBSOLETE_CIPHER"),
    (-171, "ERR_CT_CONSISTENCY_PROOF_PARSING_FAILED"),
    (-170, "ERR_UNABLE_TO_REUSE_CONNECTION_FOR_PROXY_AUTH"),
    (-169, "ERR_CT_STH_INCOMPLETE"),
    (-168, "ERR_CT_STH_PARSING_FAILED"),
    (-167, "ERR_SSL_SERVER_CERT_BAD_FORMAT"),
    (-166, "ERR_ICANN_NAME_COLLISION"),
    (-164, "ERR_SSL_CLIENT_AUTH_CERT_BAD_FORMAT"),
    (-163, "ERR_SOCKET_SEND_BUFFER_SIZE_UNCHANGEABLE"),
    (-162, "ERR_SOCKET_RECEIVE_BUFFER_SIZE_UNCHANGEABLE"),
    (-161, "ERR_SOCKET_SET_SEND_BUFFER_SIZE_ERROR"),
    (-160, "ERR_SOCKET_SET_RECEIVE_BUFFER_SIZE_ERROR"),
    (-159, "ERR_SSL_UNRECOGNIZED_NAME_ALERT"),
    (-156, "ERR_SSL_SERVER_CERT_CHANGED"),
    (-154, "ERR_WS_THROTTLE_QUEUE_TOO_LARGE"),
    (-153, "ERR_SSL_DECRYPT_ERROR_ALERT"),
    (-151, "ERR_CLIENT_AUTH_CERT_TYPE_UNSUPPORTED"),
    (-150, "ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN"),
    (-147, "ERR_ADDRESS_IN_USE"),
    (-145, "ERR_WS_PROTOCOL_ERROR"),
    (-142, "ERR_MSG_TOO_BIG"),
    (-141, "ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED"),
    (-139, "ERR_TEMPORARILY_THROTTLED"),
    (-138, "ERR_NETWORK_ACCESS_DENIED"),
    (-137, "ERR_NAME_RESOLUTION_FAILED"),
    (-136, "ERR_PROXY_CERTIFICATE_INVALID"),
    (-135, "ERR_SSL_CLIENT_AUTH_CERT_NO_PRIVATE_KEY"),
    (-134, "ERR_SSL_CLIENT_AUTH_PRIVATE_KEY_ACCESS_DENIED"),
    (-133, "ERR_PRECONNECT_MAX_SOCKET_LIMIT"),
    (-131, "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED"),
    (-130, "ERR_PROXY_CONNECTION_FAILED"),
    (-127, "ERR_PROXY_AUTH_REQUESTED"),
    (-126, "ERR_SSL_BAD_RECORD_MAC_ALERT"),
    (-125, "ERR_SSL_DECOMPRESSION_FAILURE_ALERT"),
    (-124, "ERR_WINSOCK_UNEXPECTED_WRITTEN_BYTES"),
    (-123, "ERR_SSL_NO_RENEGOTIATION"),
    (-122, "ERR_ALPN_NEGOTIATION_FAILED"),
    (-121, "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE"),
    (-120, "ERR_SOCKS_CONNECTION_FAILED"),
    (-119, "ERR_HOST_RESOLVER_QUEUE_TOO_LARGE"),
    (-118, "ERR_CONNECTION_TIMED_OUT"),
    (-117, "ERR_BAD_SSL_CLIENT_AUTH_CERT"),
    (-115, "ERR_PROXY_AUTH_UNSUPPORTED"),
    (-114, "ERR_SSL_RENEGOTIATION_REQUESTED"),
    (-113, "ERR_SSL_VERSION_OR_CIPHER_MISMATCH"),
    (-111, "ERR_TUNNEL_CONNECTION_FAILED"),
    (-110, "ERR_SSL_CLIENT_AUTH_CERT_NEEDED"),
    (-109, "ERR_ADDRESS_UNREACHABLE"),
    (-108, "ERR_ADDRESS_INVALID"),
    (-107, "ERR_SSL_PROTOCOL_ERROR"),
    (-106, "ERR_INTERNET_DISCONNECTED"),
    (-105, "ERR_NAME_NOT_RESOLVED"),
    (-104, "ERR_CONNECTION_FAILED"),
    (-103, "ERR_CONNECTION_ABORTED"),
    (-102, "ERR_CONNECTION_REFUSED"),
    (-101, "ERR_CONNECTION_RESET"),
    (-100, "ERR_CONNECTION_CLOSED"),
    (-37, "ERR_STRICT_ECH_REQUIRED"),
    (-36, "ERR_LOCAL_NETWORK_PERMISSION_MISSING"),
    (-35, "ERR_BLOCKED_IN_INCOGNITO_BY_ADMINISTRATOR"),
    (-34, "ERR_BLOCKED_BY_FINGERPRINTING_PROTECTION"),
    (-33, "ERR_NETWORK_ACCESS_REVOKED"),
    (-32, "ERR_BLOCKED_BY_ORB"),
    (-30, "ERR_BLOCKED_BY_CSP"),
    (-29, "ERR_CLEARTEXT_NOT_PERMITTED"),
    (-27, "ERR_BLOCKED_BY_RESPONSE"),
    (-26, "ERR_CONTEXT_SHUT_DOWN"),
    (-25, "ERR_UPLOAD_STREAM_REWIND_NOT_SUPPORTED"),
    (-23, "ERR_SOCKET_IS_CONNECTED"),
    (-22, "ERR_BLOCKED_BY_ADMINISTRATOR"),
    (-21, "ERR_NETWORK_CHANGED"),
    (-20, "ERR_BLOCKED_BY_CLIENT"),
    (-19, "ERR_FILE_VIRUS_INFECTED"),
    (-18, "ERR_FILE_NO_SPACE"),
    (-17, "ERR_FILE_PATH_TOO_LONG"),
    (-16, "ERR_FILE_EXISTS"),
    (-15, "ERR_SOCKET_NOT_CONNECTED"),
    (-14, "ERR_UPLOAD_FILE_CHANGED"),
    (-13, "ERR_OUT_OF_MEMORY"),
    (-12, "ERR_INSUFFICIENT_RESOURCES"),
    (-11, "ERR_NOT_IMPLEMENTED"),
    (-10, "ERR_ACCESS_DENIED"),
    (-9, "ERR_UNEXPECTED"),
    (-8, "ERR_FILE_TOO_BIG"),
    (-7, "ERR_TIMED_OUT"),
    (-6, "ERR_FILE_NOT_FOUND"),
    (-5, "ERR_INVALID_HANDLE"),
    (-4, "ERR_INVALID_ARGUMENT"),
    (-3, "ERR_ABORTED"),
    (-2, "ERR_FAILED"),
    (-1, "ERR_IO_PENDING"),
    (0, "ERR_NONE"),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Value {
        json!({
            "reqId": 7, "url": "https://example.com/a", "method": "POST",
            "headers": [["Content-Type", "text/plain"], ["content-length", "5"], ["Accept", "*/*"]],
            "hasBody": true, "redirect": "manual", "credentials": "omit", "cache": "no-store", "partition": "persist:x",
        })
    }

    #[test]
    fn fetch_params_are_read_and_the_headers_chromium_owns_are_dropped() {
        let p = parse_fetch(&params()).unwrap();
        assert_eq!(
            (p.req_id, p.url.as_str(), p.method.as_str()),
            (7, "https://example.com/a", "POST")
        );
        assert_eq!(
            p.headers,
            vec![
                ("Content-Type".to_string(), "text/plain".to_string()),
                ("Accept".to_string(), "*/*".to_string())
            ]
        );
        assert!(p.has_body);
        assert_eq!(
            (p.redirect, p.credentials, p.cache),
            (Redirect::Manual, Credentials::Omit, CacheMode::NoStore)
        );
        assert_eq!(p.partition, "persist:x");
        assert!(!p.bypass_custom_protocol_handlers);
    }

    #[test]
    fn fetch_params_default_to_a_followed_get_with_cookies() {
        let p = parse_fetch(&json!({ "reqId": 1, "url": "https://a/" })).unwrap();
        assert_eq!(
            (
                p.method.as_str(),
                p.redirect,
                p.credentials,
                p.cache,
                p.has_body
            ),
            (
                "GET",
                Redirect::Follow,
                Credentials::Include,
                CacheMode::Default,
                false
            )
        );
        assert!(p.headers.is_empty());
    }

    #[test]
    fn bad_fetch_params_say_what_is_wrong() {
        assert!(
            parse_fetch(&json!({ "url": "https://a/" }))
                .unwrap_err()
                .contains("reqId")
        );
        assert!(
            parse_fetch(&json!({ "reqId": 1 }))
                .unwrap_err()
                .contains("url")
        );
        assert!(
            parse_fetch(&json!({ "reqId": 1, "url": "https://a/", "redirect": "sideways" }))
                .unwrap_err()
                .contains("sideways")
        );
        assert!(
            parse_fetch(&json!({ "reqId": 1, "url": "https://a/", "headers": [["a"]] }))
                .unwrap_err()
                .contains("headers")
        );
        assert!(
            parse_fetch(&json!({ "reqId": 1, "url": "https://a/", "headers": "x" }))
                .unwrap_err()
                .contains("headers")
        );
    }

    #[test]
    fn flags_follow_redirect_credentials_and_cache() {
        let mut p = parse_fetch(&params()).unwrap();
        assert_eq!(
            p.url_flags(),
            UrlFlags {
                disable_cache: true,
                stop_on_redirect: true,
                ..UrlFlags::default()
            }
        );
        p.redirect = Redirect::Error;
        p.credentials = Credentials::SameOrigin;
        p.cache = CacheMode::Reload;
        assert_eq!(
            p.url_flags(),
            UrlFlags {
                skip_cache: true,
                allow_stored_credentials: true,
                stop_on_redirect: true,
                ..UrlFlags::default()
            }
        );
        p.redirect = Redirect::Follow;
        p.cache = CacheMode::OnlyIfCached;
        assert_eq!(
            p.url_flags(),
            UrlFlags {
                only_from_cache: true,
                allow_stored_credentials: true,
                ..UrlFlags::default()
            }
        );
        p.cache = CacheMode::ForceCache;
        assert_eq!(
            p.url_flags(),
            UrlFlags {
                allow_stored_credentials: true,
                ..UrlFlags::default()
            }
        );
    }

    #[test]
    fn urls_without_a_scheme_or_with_a_custom_one_while_bypassing_are_refused() {
        assert_eq!(url_scheme("HTTPS://a/").as_deref(), Some("https"));
        assert_eq!(url_scheme("/relative"), None);
        assert_eq!(url_scheme("1http://a"), None);
        assert_eq!(
            refuse_url("/relative", false).as_deref(),
            Some("net::ERR_INVALID_URL")
        );
        assert_eq!(refuse_url("omp-media://x/y", false), None);
        assert_eq!(
            refuse_url("omp-media://x/y", true).as_deref(),
            Some("net::ERR_UNKNOWN_URL_SCHEME")
        );
        assert_eq!(refuse_url("https://x/y", true), None);
    }

    #[test]
    fn a_redirect_needs_its_status_and_a_location() {
        assert!(is_redirect(302, true));
        assert!(!is_redirect(302, false));
        assert!(!is_redirect(304, true));
        assert!(!is_redirect(300, true));
    }

    #[test]
    fn reason_phrases_fill_in_for_http2() {
        assert_eq!(reason_phrase(200), "OK");
        assert_eq!(reason_phrase(404), "Not Found");
        assert_eq!(reason_phrase(299), "");
        let head = head_json(200, "", "https://a/", "https://a/", &[]);
        assert_eq!(head["statusText"], "OK");
        assert_eq!(
            head_json(200, "Fine", "https://a/", "https://a/", &[])["statusText"],
            "Fine"
        );
    }

    #[test]
    fn redirected_compares_urls_without_their_fragment() {
        assert!(!redirected("https://a/x", "https://a/x"));
        assert!(!redirected("https://a/x#top", "https://a/x"));
        assert!(redirected("https://a/x", "https://cdn.a/y"));
        assert!(!redirected("https://a/x", ""));
    }

    #[test]
    fn header_multimaps_become_one_pair_per_value() {
        let pairs = header_pairs(vec![
            ("Set-Cookie".into(), vec!["a=1".into(), "b=2".into()]),
            ("Content-Type".into(), vec!["text/plain".into()]),
            (String::new(), vec!["HTTP/1.1 200".into()]),
        ]);
        assert_eq!(
            pairs,
            vec![
                ("Set-Cookie".into(), "a=1".into()),
                ("Set-Cookie".into(), "b=2".into()),
                ("Content-Type".into(), "text/plain".into())
            ]
        );
    }

    #[test]
    fn the_head_carries_status_url_redirected_and_headers() {
        let head = head_json(
            302,
            "Found",
            "https://a/x",
            "https://a/x",
            &[("Location".into(), "/y".into())],
        );
        assert_eq!(
            head,
            json!({ "status": 302, "statusText": "Found", "url": "https://a/x", "redirected": false, "headers": [["Location", "/y"]] })
        );
        let head = head_json(200, "OK", "https://a/x", "", &[]);
        assert_eq!(head["url"], "https://a/x");
        assert_eq!(head["redirected"], false);
    }

    #[test]
    fn error_codes_have_chromiums_names() {
        assert_eq!(error_text(-102), "net::ERR_CONNECTION_REFUSED");
        assert_eq!(error_text(-105), "net::ERR_NAME_NOT_RESOLVED");
        assert_eq!(error_text(-3), "net::ERR_ABORTED");
        assert_eq!(error_text(-2), "net::ERR_FAILED");
        assert_eq!(error_text(-200), "net::ERR_CERT_COMMON_NAME_INVALID");
        assert_eq!(error_text(-99999), "net::ERR_FAILED (-99999)");
    }

    #[test]
    fn the_error_table_is_sorted_and_unique() {
        assert!(ERROR_NAMES.windows(2).all(|w| w[0].0 < w[1].0));
        assert!(
            ERROR_NAMES
                .iter()
                .all(|(code, name)| *code <= 0 && name.starts_with("ERR_"))
        );
    }

    #[test]
    fn resolve_hosts_become_urls_and_addresses_get_their_family() {
        assert_eq!(resolve_origin("example.com"), "http://example.com");
        assert_eq!(resolve_origin("::1"), "http://[::1]");
        assert_eq!(resolve_origin("[::1]"), "http://[::1]");
        let answer = endpoints_json(&[
            "93.184.216.34".into(),
            "2606:2800:220:1::1".into(),
            "not an ip".into(),
        ]);
        assert_eq!(
            answer,
            json!({ "endpoints": [
                { "address": "93.184.216.34", "family": "ipv4" },
                { "address": "2606:2800:220:1::1", "family": "ipv6" },
            ] })
        );
    }
}
