//! API error type; every failure is rendered as a JSON body
//! `{"error": {"code": "...", "message": "..."}}` with a matching status.

use axum::{
    Json,
    extract::rejection::JsonRejection,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    InvalidJson(String),

    #[error("{0}")]
    Unprocessable(String),

    #[error("script error: {0}")]
    Script(String),

    #[error("{0}")]
    LimitExceeded(String),

    #[error("request body too large")]
    PayloadTooLarge,

    #[error("not found")]
    NotFound,

    #[error("missing or invalid bearer token")]
    Unauthorized,

    #[error("server is at capacity, retry later")]
    Overloaded,

    #[error("job exceeded its time budget")]
    Timeout,

    #[error("internal error")]
    Internal(String),
}

#[derive(Serialize)]
struct Body<'a> {
    error: Inner<'a>,
}

#[derive(Serialize)]
struct Inner<'a> {
    code: &'a str,
    message: String,
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::InvalidJson(_) => (StatusCode::BAD_REQUEST, "invalid_json"),
            Self::Unprocessable(_) => (StatusCode::UNPROCESSABLE_ENTITY, "unprocessable"),
            Self::Script(_) => (StatusCode::UNPROCESSABLE_ENTITY, "script_error"),
            Self::LimitExceeded(_) => (StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded"),
            Self::PayloadTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::Overloaded => (StatusCode::SERVICE_UNAVAILABLE, "overloaded"),
            Self::Timeout => (StatusCode::GATEWAY_TIMEOUT, "timeout"),
            Self::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        if let Self::Internal(detail) = &self {
            // Details stay in the logs; clients only see a generic message.
            tracing::error!(%detail, "internal error");
        }
        let body = Body {
            error: Inner {
                code,
                message: self.to_string(),
            },
        };
        let mut res = (status, Json(body)).into_response();
        match self {
            Self::Overloaded => {
                res.headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            }
            Self::Unauthorized => {
                res.headers_mut()
                    .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            }
            _ => {}
        }
        res
    }
}

impl From<JsonRejection> for ApiError {
    fn from(r: JsonRejection) -> Self {
        match r {
            JsonRejection::JsonDataError(e) => Self::InvalidJson(e.body_text()),
            JsonRejection::JsonSyntaxError(e) => Self::InvalidJson(e.body_text()),
            JsonRejection::MissingJsonContentType(_) => {
                Self::BadRequest("expected `Content-Type: application/json`".into())
            }
            JsonRejection::BytesRejection(e) if e.status() == StatusCode::PAYLOAD_TOO_LARGE => {
                Self::PayloadTooLarge
            }
            other => Self::BadRequest(other.body_text()),
        }
    }
}

/// JSON extractor whose rejections use [`ApiError`]'s format
#[derive(axum::extract::FromRequest)]
#[from_request(via(axum::Json), rejection(ApiError))]
pub struct ApiJson<T>(pub T);

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    async fn render(e: ApiError) -> (StatusCode, axum::http::HeaderMap, serde_json::Value) {
        let res = e.into_response();
        let (parts, body) = res.into_parts();
        let bytes = to_bytes(body, usize::MAX).await.unwrap();
        (
            parts.status,
            parts.headers,
            serde_json::from_slice(&bytes).unwrap(),
        )
    }

    #[tokio::test]
    async fn every_variant_maps_to_status_and_code() {
        let cases = [
            (ApiError::BadRequest("m".into()), 400, "bad_request"),
            (ApiError::InvalidJson("m".into()), 400, "invalid_json"),
            (ApiError::Unprocessable("m".into()), 422, "unprocessable"),
            (ApiError::Script("m".into()), 422, "script_error"),
            (ApiError::LimitExceeded("m".into()), 422, "limit_exceeded"),
            (ApiError::PayloadTooLarge, 413, "payload_too_large"),
            (ApiError::NotFound, 404, "not_found"),
            (ApiError::Unauthorized, 401, "unauthorized"),
            (ApiError::Overloaded, 503, "overloaded"),
            (ApiError::Timeout, 504, "timeout"),
            (ApiError::Internal("m".into()), 500, "internal"),
        ];
        for (err, status, code) in cases {
            let (s, h, v) = render(err).await;
            assert_eq!(s.as_u16(), status, "{code}");
            assert_eq!(v["error"]["code"], code);
            assert_eq!(h.contains_key(header::RETRY_AFTER), code == "overloaded");
            assert_eq!(
                h.contains_key(header::WWW_AUTHENTICATE),
                code == "unauthorized"
            );
        }
    }

    #[tokio::test]
    async fn messages_are_passed_through_except_internal_details() {
        let (_, _, v) = render(ApiError::Script("line 3: oops".into())).await;
        assert_eq!(v["error"]["message"], "script error: line 3: oops");
        let (_, _, v) = render(ApiError::Internal("secret path /etc".into())).await;
        assert_eq!(v["error"]["message"], "internal error");
    }
}
