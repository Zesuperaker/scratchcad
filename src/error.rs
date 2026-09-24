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

    #[error("script not found")]
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
