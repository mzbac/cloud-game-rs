pub(crate) fn append_query_param(mut url: String, key: &str, value: Option<&str>) -> String {
    let Some(value) = value else {
        return url;
    };

    let has_query = url.contains('?');
    let key_prefix_question = format!("?{key}=");
    let key_prefix_amp = format!("&{key}=");
    if url.contains(&key_prefix_question) || url.contains(&key_prefix_amp) {
        return url;
    }

    url.push(if has_query { '&' } else { '?' });
    url.push_str(key);
    url.push('=');
    url.push_str(&url_encode_query_component(value));
    url
}

pub(crate) fn redact_url_query_param_for_log(url: &str, key: &str) -> String {
    if url.is_empty() || key.is_empty() {
        return url.to_string();
    }

    let bytes = url.as_bytes();
    let key_bytes = key.as_bytes();
    let mut out = String::with_capacity(url.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let byte = bytes[i];
        if (byte == b'?' || byte == b'&')
            && bytes.get(i + 1..).is_some_and(|tail| {
                tail.starts_with(key_bytes) && tail.get(key_bytes.len()) == Some(&b'=')
            })
        {
            out.push(byte as char);
            out.push_str(key);
            out.push('=');
            out.push_str("[REDACTED]");
            i = i.saturating_add(1 + key_bytes.len() + 1);
            while i < bytes.len() && bytes[i] != b'&' && bytes[i] != b'#' {
                i = i.saturating_add(1);
            }
            continue;
        }

        out.push(byte as char);
        i = i.saturating_add(1);
    }
    out
}

fn url_encode_query_component(value: &str) -> String {
    use std::fmt::Write;

    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                let _ = write!(&mut out, "%{:02X}", byte);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_query_param_inserts_and_skips_existing() {
        assert_eq!(
            append_query_param("ws://example.com/ws".to_string(), "token", Some("abc")),
            "ws://example.com/ws?token=abc"
        );
        assert_eq!(
            append_query_param("ws://example.com/ws?x=1".to_string(), "token", Some("abc")),
            "ws://example.com/ws?x=1&token=abc"
        );
        assert_eq!(
            append_query_param(
                "ws://example.com/ws?token=already&x=1".to_string(),
                "token",
                Some("abc")
            ),
            "ws://example.com/ws?token=already&x=1"
        );
        assert_eq!(
            append_query_param("ws://example.com/ws".to_string(), "token", None),
            "ws://example.com/ws"
        );
    }

    #[test]
    fn redact_url_query_param_for_log_redacts_query_values() {
        assert_eq!(
            redact_url_query_param_for_log("ws://example.com/ws?token=secret&x=1", "token"),
            "ws://example.com/ws?token=[REDACTED]&x=1"
        );
        assert_eq!(
            redact_url_query_param_for_log("ws://example.com/ws?x=1&token=secret", "token"),
            "ws://example.com/ws?x=1&token=[REDACTED]"
        );
        assert_eq!(
            redact_url_query_param_for_log("ws://example.com/ws?x=1", "token"),
            "ws://example.com/ws?x=1"
        );
    }
}
