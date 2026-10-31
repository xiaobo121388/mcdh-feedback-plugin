use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use zeroize::Zeroize;

const SERVICE: &str = "com.mcdh.plugin.blockecho.feedback";
const USER: &str = "netease-session-v1";

fn profile_user() -> String {
    let profile = std::env::current_dir()
        .and_then(std::fs::canonicalize)
        .unwrap_or_default();
    format!(
        "{USER}:{}",
        hex::encode(Sha256::digest(
            profile.to_string_lossy().to_lowercase().as_bytes()
        ))
    )
}

pub fn ensure_logged_out() -> crate::fault::Result<()> {
    match keyring::Entry::new(SERVICE, &profile_user()).and_then(|entry| entry.delete_credential())
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(crate::fault::Fault::new(
            "credential_store_unavailable",
            "Windows Credential Manager could not remove the session",
        )),
    }
}

#[derive(Debug)]
pub(crate) struct SessionStore {
    token: RwLock<Option<String>>,
    user: String,
}

impl SessionStore {
    pub fn new() -> Self {
        let user = profile_user();
        let token = keyring::Entry::new(SERVICE, &user)
            .ok()
            .and_then(|entry| entry.get_password().ok());
        Self {
            token: RwLock::new(token.filter(|token| !token.is_empty())),
            user,
        }
    }
    pub fn for_user(_: &str) -> Self {
        Self::new()
    }
    pub async fn get(&self) -> Option<String> {
        self.token.read().await.clone()
    }
    pub async fn install(&self, mut token: String) -> bool {
        let saved = keyring::Entry::new(SERVICE, &self.user)
            .and_then(|entry| entry.set_password(&token))
            .is_ok();
        if saved {
            *self.token.write().await = Some(token.clone());
        }
        token.zeroize();
        saved
    }
    pub async fn clear(&self) {
        if let Some(mut token) = self.token.write().await.take() {
            token.zeroize();
        }
        if let Ok(entry) = keyring::Entry::new(SERVICE, &self.user) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn credential_namespace_is_not_the_legacy_viewer() {
        assert_ne!(super::SERVICE, "com.mcfeedback.viewer");
    }
}
