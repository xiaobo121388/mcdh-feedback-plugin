use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use crate::fault::{Fault, Result};

pub fn reparse(path: &Path) -> Result<bool> {
    let meta = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(meta.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    {
        Ok(meta.file_type().is_symlink())
    }
}

pub fn check_chain(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) if reparse(ancestor)? => {
                return Err(Fault::new(
                    "unsafe_path",
                    "Directory links and reparse points are not allowed",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn fragment(value: &str) -> Result<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c < ' ' || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(Fault::new("unsafe_path", "Invalid Windows path segment"));
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if device {
        return Err(Fault::new(
            "unsafe_path",
            "Windows device names are not allowed",
        ));
    }
    Ok(())
}

pub fn relative(value: &str, document: bool) -> Result<PathBuf> {
    if value.is_empty()
        || value.len() > 2048
        || value.starts_with(['/', '\\'])
        || value.contains(':')
    {
        return Err(Fault::new(
            "unsafe_path",
            "Use a relative path inside the feedback directory",
        ));
    }
    let mut path = PathBuf::new();
    for name in value.split(['/', '\\']) {
        fragment(name)?;
        if name.eq_ignore_ascii_case(".trash") || name.starts_with(".mcdh-") {
            return Err(Fault::new(
                "unsafe_path",
                "This path is reserved for internal data",
            ));
        }
        path.push(name);
    }
    if document && !is_markdown(&path) {
        return Err(Fault::invalid(
            "Only .md and .markdown documents are supported",
        ));
    }
    Ok(path)
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
}

pub fn feedback_root(component_root: &Path, directory: &str) -> Result<PathBuf> {
    if !component_root.is_absolute() || !component_root.is_dir() {
        return Err(Fault::new(
            "component_missing",
            "The MCDH component directory is unavailable",
        ));
    }
    check_chain(component_root)?;
    let component_root = fs::canonicalize(component_root)?;
    let selected = Path::new(directory);
    let root = if selected.is_absolute() {
        for part in selected.components() {
            match part {
                Component::Prefix(prefix)
                    if matches!(
                        prefix.kind(),
                        std::path::Prefix::DeviceNS(_) | std::path::Prefix::Verbatim(_)
                    ) =>
                {
                    return Err(Fault::new(
                        "unsafe_path",
                        "Windows device namespaces are not supported",
                    ));
                }
                Component::Normal(name) => fragment(
                    name.to_str()
                        .ok_or_else(|| Fault::invalid("Path must be Unicode"))?,
                )?,
                Component::CurDir | Component::ParentDir => {
                    return Err(Fault::new(
                        "unsafe_path",
                        "Directory traversal is not allowed",
                    ));
                }
                _ => {}
            }
        }
        selected.to_path_buf()
    } else {
        component_root.join(relative(directory, false)?)
    };
    if root == component_root {
        return Err(Fault::invalid(
            "Choose a feedback subdirectory, not the component root",
        ));
    }
    check_chain(&root)?;
    if root.exists() && !root.is_dir() {
        return Err(Fault::invalid("Feedback path is not a directory"));
    }
    if root.exists() {
        let resolved = fs::canonicalize(&root)?;
        if resolved == component_root {
            return Err(Fault::invalid(
                "Choose a feedback subdirectory, not the component root",
            ));
        }
        Ok(resolved)
    } else {
        Ok(root)
    }
}

pub fn inside(root: &Path, relative: &Path) -> Result<PathBuf> {
    let target = root.join(relative);
    check_chain(&target)?;
    if !target.starts_with(root) {
        return Err(Fault::new(
            "unsafe_path",
            "Path escaped the feedback directory",
        ));
    }
    if target.exists()
        && root.exists()
        && !fs::canonicalize(&target)?.starts_with(fs::canonicalize(root)?)
    {
        return Err(Fault::new(
            "unsafe_path",
            "Resolved path escaped the feedback directory",
        ));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_windows_escape_and_devices_on_every_platform() {
        for path in [
            "../x.md",
            "a/../x.md",
            "C:\\x.md",
            "\\\\server\\x.md",
            "/x.md",
            "a//b.md",
            "a/./b.md",
            "NUL.md",
            "con.MD",
            "COM1.md",
            "CON .md",
            "CONOUT$.md",
            "x.md:stream",
            "x. /y.md",
            ".trash/x.md",
            "x.txt",
        ] {
            assert!(relative(path, true).is_err(), "accepted {path}");
        }
        assert!(relative("报告/中文.MD", true).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn junctions_cannot_redirect_document_operations() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("feedback");
        let outside = temp.path().join("outside");
        let link = root.join("redirect");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let plain = |path: &Path| {
            let value = path.to_string_lossy();
            value.strip_prefix("\\\\?\\").unwrap_or(&value).to_string()
        };
        let output = std::process::Command::new(r"C:\Windows\System32\cmd.exe")
            .raw_arg(format!(
                "/D /C mklink /J \"{}\" \"{}\"",
                plain(&link),
                plain(&outside)
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed ({:?} -> {:?}): {} {}",
            plain(&link),
            plain(&outside),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(inside(&root, &relative("redirect/report.md", true).unwrap()).is_err());
        assert!(feedback_root(temp.path(), link.to_str().unwrap()).is_err());
        assert!(link.starts_with(temp.path()));
        fs::remove_dir(&link).unwrap();
        assert!(outside.is_dir());
        assert!(feedback_root(temp.path(), &plain(temp.path())).is_err());
        assert!(feedback_root(temp.path(), r"\\.\GLOBALROOT\Device\Example").is_err());
        assert!(feedback_root(temp.path(), r"\\?\GLOBALROOT\Device\Example").is_err());
    }
}
