use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Fault {
    pub code: String,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, Fault>;

impl Fault {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_arguments", message)
    }
}

impl From<std::io::Error> for Fault {
    fn from(error: std::io::Error) -> Self {
        let (code, message) = match error.kind() {
            std::io::ErrorKind::NotFound => (
                "not_found",
                "The requested file or directory does not exist",
            ),
            std::io::ErrorKind::AlreadyExists => {
                ("already_exists", "The destination already exists")
            }
            std::io::ErrorKind::PermissionDenied => (
                "permission_denied",
                "Access to the requested file was denied",
            ),
            _ => ("io_error", "The local file operation failed"),
        };
        Self::new(code, message)
    }
}

impl From<serde_json::Error> for Fault {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid("Invalid JSON data")
    }
}

impl From<crate::error::AppError> for Fault {
    fn from(error: crate::error::AppError) -> Self {
        use crate::error::ErrorCode;
        match error.code {
            ErrorCode::AuthRequired => Self::new(
                "auth_required",
                "Open Feedback settings in MCDH and sign in",
            ),
            ErrorCode::SessionExpired => Self::new(
                "session_expired",
                "The NetEase session expired; sign in again in MCDH",
            ),
            ErrorCode::SecurityVerificationRequired => {
                Self::new("security_verification_required", error.message)
            }
            ErrorCode::RateLimited => Self::new("rate_limited", error.message),
            ErrorCode::NetworkError => Self::new("network_error", error.message),
            ErrorCode::RemoteApiError => Self::new("remote_api_error", error.message),
            ErrorCode::InvalidArgument => Self::invalid(error.message),
        }
    }
}

pub fn text<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| Fault::invalid(format!("Missing string field: {key}")))
}
