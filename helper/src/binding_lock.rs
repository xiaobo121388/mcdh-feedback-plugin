use crate::{
    fault::{Fault, Result, text},
    paths,
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub fn acquire(data: &Path) -> Result<Value> {
    let path = data.join("binding-edit.lock");
    paths::check_chain(&path)?;
    let start = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let token = Uuid::new_v4().to_string();
                let created = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| Fault::invalid("System clock is invalid"))?
                    .as_secs();
                file.write_all(&serde_json::to_vec(
                    &json!({"token":token,"created":created}),
                )?)?;
                file.sync_all()?;
                return Ok(json!({"token":token}));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Plugin calls have a 60-second deadline; abandoned edits expire after two minutes.
                let metadata = match fs::metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                if metadata
                    .modified()?
                    .elapsed()
                    .is_ok_and(|age| age > Duration::from_secs(120))
                {
                    match fs::remove_file(&path) {
                        Ok(()) => continue,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error.into()),
                    }
                }
                if start.elapsed() >= Duration::from_secs(5) {
                    return Err(Fault::new(
                        "settings_busy",
                        "Another client is updating feedback bindings; retry shortly",
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub fn release(data: &Path, input: &Value) -> Result<Value> {
    let path = data.join("binding-edit.lock");
    paths::check_chain(&path)?;
    let content: Value = serde_json::from_slice(&fs::read(&path)?)?;
    if content["token"].as_str() != Some(text(input, "token")?) {
        return Err(Fault::new(
            "settings_lock_mismatch",
            "Binding edit lock changed",
        ));
    }
    fs::remove_file(path)?;
    Ok(json!({"released":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_different_client_cannot_release_an_edit() {
        let temp = tempfile::tempdir().unwrap();
        let lock = acquire(temp.path()).unwrap();
        assert!(release(temp.path(), &json!({"token":"wrong"})).is_err());
        release(temp.path(), &lock).unwrap();
        let second = acquire(temp.path()).unwrap();
        release(temp.path(), &second).unwrap();
    }
}
