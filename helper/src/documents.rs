use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use fs2::FileExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    fault::{Fault, Result, text},
    paths,
};

pub const MAX_DOCUMENT: usize = 16 * 1024 * 1024;
const CHUNK: usize = 32 * 1024;

pub fn revision(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub struct DirectoryLock {
    _file: File,
}

impl DirectoryLock {
    pub fn acquire(data: &Path, root: &Path) -> Result<Self> {
        let directory = data.join("locks");
        paths::check_chain(&directory)?;
        fs::create_dir_all(&directory)?;
        let key = revision(root.to_string_lossy().to_lowercase().as_bytes());
        let path = directory.join(format!("{key}.lock"));
        paths::check_chain(&path)?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        let start = Instant::now();
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && start.elapsed() < Duration::from_secs(5) =>
                {
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    return Err(Fault::new(
                        "document_busy",
                        "Another operation is using this feedback directory",
                    ));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

fn bytes(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    if file.metadata()?.len() > MAX_DOCUMENT as u64 {
        return Err(Fault::new(
            "document_too_large",
            "Documents may not exceed 16 MiB",
        ));
    }
    let mut bytes = Vec::new();
    file.take((MAX_DOCUMENT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_DOCUMENT {
        return Err(Fault::new(
            "document_too_large",
            "Documents may not exceed 16 MiB",
        ));
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| Fault::new("invalid_encoding", "Document must be UTF-8"))?;
    Ok(bytes)
}

fn expected(input: &Value, bytes: &[u8], required: bool) -> Result<()> {
    match input["expected_revision"].as_str() {
        Some(value) if value == revision(bytes) => Ok(()),
        Some(_) => Err(Fault::new(
            "revision_conflict",
            "Document changed; read it again before modifying it",
        )),
        None if !required => Ok(()),
        None => Err(Fault::invalid(
            "expected_revision is required for an existing document",
        )),
    }
}

fn atomic(path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Fault::invalid("Missing parent directory"))?;
    paths::check_chain(path)?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".mcdh-write-")
        .tempfile_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    paths::check_chain(path)?;
    if replace {
        temporary.persist(path)
    } else {
        temporary.persist_noclobber(path)
    }
    .map_err(|error| Fault::from(error.error))?;
    Ok(())
}

fn document(root: &Path, input: &Value, key: &str) -> Result<PathBuf> {
    paths::inside(root, &paths::relative(text(input, key)?, true)?)
}

pub fn execute(operation: &str, data: &Path, root: &Path, input: &Value) -> Result<Value> {
    let _lock = DirectoryLock::acquire(data, root)?;
    paths::check_chain(root)?;
    match operation {
        "list_feedback_documents" => list(root, input),
        "read_feedback_document" => read(root, input),
        "write_feedback_document" => write(root, input),
        "rename_feedback_document" => rename(root, input),
        "delete_feedback_document" => delete(root, input),
        "restore_feedback_document" => restore(root, input),
        _ => Err(Fault::invalid("Unknown document operation")),
    }
}

fn list(root: &Path, input: &Value) -> Result<Value> {
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let limit = input["limit"].as_u64().unwrap_or(100).clamp(1, 500) as usize;
    let keyword = input["keyword"].as_str().unwrap_or("").to_lowercase();
    let mut entries = Vec::new();
    let mut stack = if root.exists() {
        vec![(root.to_path_buf(), 0)]
    } else {
        vec![]
    };
    let mut visited = 0;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 32 {
            return Err(Fault::new(
                "directory_limit",
                "Feedback directory nesting exceeds 32 levels",
            ));
        }
        for entry in fs::read_dir(directory)? {
            visited += 1;
            if visited > 10_000 {
                return Err(Fault::new(
                    "directory_limit",
                    "Feedback directory contains more than 10000 entries",
                ));
            }
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case(".trash") || name.starts_with(".mcdh-") {
                continue;
            }
            let path = entry.path();
            if paths::reparse(&path)? {
                continue;
            }
            let meta = entry.metadata()?;
            if meta.is_dir() {
                stack.push((path, depth + 1));
            } else if meta.is_file() && paths::is_markdown(&path) {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| Fault::invalid("Invalid document path"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !relative.to_lowercase().contains(&keyword) {
                    continue;
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|value| value.as_secs());
                entries.push(json!({"path":relative,"size":meta.len(),"modified_at":modified}));
            }
        }
    }
    entries.sort_by(|left, right| {
        left["path"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .cmp(&right["path"].as_str().unwrap_or("").to_lowercase())
    });
    let total = entries.len();
    let items: Vec<_> = entries.into_iter().skip(offset).take(limit).collect();
    let next = offset.saturating_add(items.len());
    Ok(
        json!({"items":items,"total":total,"offset":offset,"next_offset":if next < total {Some(next)} else {None},"directory_exists":root.is_dir()}),
    )
}

fn read(root: &Path, input: &Value) -> Result<Value> {
    let source = bytes(&document(root, input, "path")?)?;
    expected(input, &source, false)?;
    let content = std::str::from_utf8(&source).map_err(|_| Fault::invalid("Invalid UTF-8"))?;
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    if offset > content.len() || !content.is_char_boundary(offset) {
        return Err(Fault::invalid(
            "offset must be a UTF-8 byte boundary in the document",
        ));
    }
    let limit = input["limit"]
        .as_u64()
        .unwrap_or(CHUNK as u64)
        .clamp(4, CHUNK as u64) as usize;
    let mut end = offset.saturating_add(limit).min(content.len());
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    Ok(
        json!({"path":text(input,"path")?,"content":&content[offset..end],"revision":revision(&source),"size":source.len(),"offset":offset,"next_offset":if end < content.len() {Some(end)} else {None}}),
    )
}

fn write(root: &Path, input: &Value) -> Result<Value> {
    let path = document(root, input, "path")?;
    let content = text(input, "content")?;
    if content.len() > 64 * 1024 || content.contains('\0') {
        return Err(Fault::invalid(
            "Write at most 64 KiB of UTF-8 per call, without NUL characters",
        ));
    }
    let mode = input["mode"].as_str().unwrap_or("create");
    if !matches!(mode, "create" | "replace" | "append") {
        return Err(Fault::invalid("mode must be create, replace or append"));
    }
    let exists = path.exists();
    if exists && mode == "create" {
        return Err(Fault::new(
            "already_exists",
            "Document already exists; read it before replacing it",
        ));
    }
    if !exists && mode != "create" {
        return Err(Fault::new(
            "not_found",
            "Document does not exist; use create first",
        ));
    }
    let old = if exists { bytes(&path)? } else { vec![] };
    if exists {
        expected(input, &old, true)?;
    }
    let mut updated = if mode == "append" { old } else { vec![] };
    updated.extend_from_slice(content.as_bytes());
    if updated.len() > MAX_DOCUMENT {
        return Err(Fault::new(
            "document_too_large",
            "Documents may not exceed 16 MiB",
        ));
    }
    atomic(&path, &updated, exists)?;
    Ok(
        json!({"path":text(input,"path")?,"revision":revision(&updated),"size":updated.len(),"mode":mode}),
    )
}

fn rename(root: &Path, input: &Value) -> Result<Value> {
    let source = document(root, input, "path")?;
    let target = document(root, input, "new_path")?;
    let content = bytes(&source)?;
    expected(input, &content, true)?;
    if target.exists() {
        return Err(Fault::new("already_exists", "Destination already exists"));
    }
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| Fault::invalid("Missing parent"))?,
    )?;
    paths::check_chain(&target)?;
    // A hard link publishes without overwriting even if an external writer creates the target.
    fs::hard_link(&source, &target)?;
    if let Err(error) = fs::remove_file(&source) {
        let _ = fs::remove_file(&target);
        return Err(error.into());
    }
    Ok(json!({"path":text(input,"new_path")?,"revision":revision(&content),"size":content.len()}))
}

fn delete(root: &Path, input: &Value) -> Result<Value> {
    let source = document(root, input, "path")?;
    let content = bytes(&source)?;
    expected(input, &content, true)?;
    let id = Uuid::new_v4().to_string();
    let directory = root.join(".trash").join(&id);
    paths::check_chain(&directory)?;
    fs::create_dir_all(&directory)?;
    let metadata = json!({"path":text(input,"path")?,"revision":revision(&content)});
    atomic(
        &directory.join("metadata.json"),
        &serde_json::to_vec(&metadata)?,
        false,
    )?;
    fs::rename(source, directory.join("document.md"))?;
    Ok(json!({"trash_id":id,"path":text(input,"path")?,"revision":revision(&content)}))
}

fn restore(root: &Path, input: &Value) -> Result<Value> {
    let id = Uuid::parse_str(text(input, "trash_id")?)
        .map_err(|_| Fault::invalid("Invalid trash_id"))?
        .to_string();
    let directory = root.join(".trash").join(&id);
    paths::check_chain(&directory)?;
    let metadata_path = directory.join("metadata.json");
    if fs::metadata(&metadata_path)?.len() > 8192 {
        return Err(Fault::invalid("Invalid trash metadata"));
    }
    let metadata: Value = serde_json::from_slice(&fs::read(&metadata_path)?)?;
    let target = document(root, &metadata, "path")?;
    let source = directory.join("document.md");
    paths::check_chain(&source)?;
    let content = bytes(&source)?;
    expected(
        &json!({"expected_revision":metadata["revision"]}),
        &content,
        true,
    )?;
    if target.exists() {
        return Err(Fault::new(
            "already_exists",
            "Original document path is occupied",
        ));
    }
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| Fault::invalid("Missing parent"))?,
    )?;
    paths::check_chain(&target)?;
    fs::hard_link(&source, &target)?;
    fs::remove_file(source)?;
    fs::remove_file(metadata_path)?;
    fs::remove_dir(directory)?;
    Ok(json!({"path":metadata["path"],"revision":revision(&content),"size":content.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_conflicts_and_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("反馈");
        let run = |op, input| execute(op, temp.path(), &root, &input);
        let created = run(
            "write_feedback_document",
            json!({"path":"日报/测试.md","content":"# 反馈\n"}),
        )
        .unwrap();
        assert!(
            run(
                "write_feedback_document",
                json!({"path":"日报/测试.md","content":"bad"})
            )
            .is_err()
        );
        assert!(run("write_feedback_document", json!({"path":"日报/测试.md","content":"bad","mode":"replace","expected_revision":"wrong"})).is_err());
        let updated = run("write_feedback_document", json!({"path":"日报/测试.md","content":"正文","mode":"append","expected_revision":created["revision"]})).unwrap();
        let read = run(
            "read_feedback_document",
            json!({"path":"日报/测试.md","limit":4}),
        )
        .unwrap();
        assert!(read["next_offset"].is_number());
        assert!(
            run(
                "read_feedback_document",
                json!({"path":"日报/测试.md","offset":3})
            )
            .is_err()
        );
        let renamed = run("rename_feedback_document", json!({"path":"日报/测试.md","new_path":"归档.markdown","expected_revision":updated["revision"]})).unwrap();
        let deleted = run(
            "delete_feedback_document",
            json!({"path":"归档.markdown","expected_revision":renamed["revision"]}),
        )
        .unwrap();
        assert_eq!(
            run("list_feedback_documents", json!({})).unwrap()["total"],
            0
        );
        run(
            "restore_feedback_document",
            json!({"trash_id":deleted["trash_id"]}),
        )
        .unwrap();
        assert_eq!(
            run("list_feedback_documents", json!({})).unwrap()["total"],
            1
        );
    }

    #[test]
    fn concurrent_replacements_have_one_winner() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("feedback");
        let created = execute(
            "write_feedback_document",
            temp.path(),
            &root,
            &json!({"path":"x.md","content":"before"}),
        )
        .unwrap();
        let handles: Vec<_> = (0..4).map(|index| {
            let data = temp.path().to_path_buf(); let root = root.clone(); let revision = created["revision"].clone();
            std::thread::spawn(move || execute("write_feedback_document", &data, &root, &json!({"path":"x.md","mode":"replace","content":index.to_string(),"expected_revision":revision})))
        }).collect();
        let successes = handles
            .into_iter()
            .filter_map(|handle| handle.join().unwrap().ok())
            .count();
        assert_eq!(successes, 1);
    }

    #[test]
    fn external_changes_and_occupied_restore_are_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("feedback");
        let created = execute(
            "write_feedback_document",
            temp.path(),
            &root,
            &json!({"path":"x.md","content":"one"}),
        )
        .unwrap();
        fs::write(root.join("x.md"), "external").unwrap();
        assert!(
            execute(
                "delete_feedback_document",
                temp.path(),
                &root,
                &json!({"path":"x.md","expected_revision":created["revision"]})
            )
            .is_err()
        );
        let deleted = execute(
            "delete_feedback_document",
            temp.path(),
            &root,
            &json!({"path":"x.md","expected_revision":revision(b"external")}),
        )
        .unwrap();
        fs::write(root.join("x.md"), "occupied").unwrap();
        assert!(
            execute(
                "restore_feedback_document",
                temp.path(),
                &root,
                &json!({"trash_id":deleted["trash_id"]})
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(root.join("x.md")).unwrap(), "occupied");
    }

    #[test]
    fn chunked_reads_preserve_unicode_and_detect_changed_versions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("feedback");
        let content = "中文🙂\n".repeat(1000);
        let created = execute(
            "write_feedback_document",
            temp.path(),
            &root,
            &json!({"path":"x.md","content":content}),
        )
        .unwrap();
        let mut offset = 0;
        let mut received = String::new();
        loop {
            let read = execute("read_feedback_document", temp.path(), &root, &json!({"path":"x.md","offset":offset,"limit":7,"expected_revision":created["revision"]})).unwrap();
            received.push_str(read["content"].as_str().unwrap());
            if let Some(next) = read["next_offset"].as_u64() {
                assert!(next > offset);
                offset = next;
            } else {
                break;
            }
        }
        assert_eq!(received, content);
        let updated = execute("write_feedback_document", temp.path(), &root, &json!({"path":"x.md","content":"new","mode":"append","expected_revision":created["revision"]})).unwrap();
        assert_ne!(updated["revision"], created["revision"]);
        assert!(
            execute(
                "read_feedback_document",
                temp.path(),
                &root,
                &json!({"path":"x.md","expected_revision":created["revision"]})
            )
            .is_err()
        );
    }
}
