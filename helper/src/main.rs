// Scope existing style exceptions to the shared login and cryptography modules.
#[allow(dead_code, clippy::needless_range_loop)]
#[path = "netease/api.rs"]
mod api;
#[allow(clippy::chunks_exact_to_as_chunks)]
#[path = "netease/crypto.rs"]
mod crypto;
#[path = "netease/error.rs"]
mod error;
#[path = "netease/models.rs"]
mod models;

mod binding_lock;
mod catalog;
mod documents;
mod fault;
mod paths;
mod queries;
mod session;
mod workspaces;

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroize;

use fault::{Fault, Result};
use workspaces::Workspace;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    operation: String,
    data_dir: PathBuf,
    #[serde(default)]
    input: Value,
    workspace: Option<Workspace>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 || args[0] != "--request" || args[2] != "--response" {
        println!(
            "{}",
            json!({"ok":false,"error":{"code":"invalid_arguments","message":"Expected --request and --response paths"}})
        );
        std::process::exit(2);
    }
    let request_path = PathBuf::from(&args[1]);
    let response_path = PathBuf::from(&args[3]);
    let result = run(&request_path, &response_path).await;
    match result {
        Ok(()) => println!("{}", json!({"ok":true})),
        Err(error) => {
            println!("{}", json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}

fn ipc_path(path: &Path, directory: &Path) -> Result<()> {
    if !path.is_absolute()
        || path.parent().map(fs::canonicalize).transpose()? != Some(fs::canonicalize(directory)?)
    {
        return Err(Fault::new(
            "unsafe_ipc_path",
            "IPC files must be inside the plugin data ipc directory",
        ));
    }
    paths::check_chain(path)
}

async fn run(request_path: &Path, response_path: &Path) -> Result<()> {
    let cwd = fs::canonicalize(std::env::current_dir()?)?;
    let ipc = cwd.join("ipc");
    ipc_path(request_path, &ipc)?;
    ipc_path(response_path, &ipc)?;
    clean_expired_ipc(&ipc)?;
    let mut content = String::new();
    fs::File::open(request_path)?
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut content)?;
    if content.len() > 2 * 1024 * 1024 {
        return Err(Fault::invalid("Request exceeds 2 MiB"));
    }
    let request: Request = serde_json::from_str(&content)?;
    if fs::canonicalize(&request.data_dir)? != cwd {
        return Err(Fault::invalid("Plugin data directory mismatch"));
    }
    let result = tokio::time::timeout(Duration::from_secs(54), dispatch(&request))
        .await
        .unwrap_or_else(|_| {
            Err(Fault::new(
                "timeout",
                "Operation timed out; retry or use Cookie login",
            ))
        });
    let response = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    let response = serde_json::to_vec(&response)?;
    if response.len() > 1900 * 1024 {
        return Err(Fault::new(
            "result_too_large",
            "Result exceeds the bounded IPC size; use smaller pages",
        ));
    }
    let mut file = tempfile::Builder::new()
        .prefix(".response-")
        .tempfile_in(&ipc)?;
    file.write_all(&response)?;
    file.as_file().sync_all()?;
    file.persist_noclobber(response_path)
        .map_err(|error| Fault::from(error.error))?;
    Ok(())
}

fn clean_expired_ipc(directory: &Path) -> Result<()> {
    for entry in fs::read_dir(directory)?.take(10_000) {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let known = name.ends_with(".request.json")
            || name.ends_with(".response.json")
            || name.starts_with(".response-");
        if !known || !entry.file_type()?.is_file() || paths::reparse(&entry.path())? {
            continue;
        }
        if entry
            .metadata()?
            .modified()?
            .elapsed()
            .is_ok_and(|age| age > Duration::from_secs(1800))
        {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

async fn dispatch(request: &Request) -> Result<Value> {
    let op = request.operation.as_str();
    if op == "acquire_binding_lock" {
        return binding_lock::acquire(&request.data_dir);
    }
    if op == "release_binding_lock" {
        return binding_lock::release(&request.data_dir, &request.input);
    }
    if op == "list_workspaces" {
        return workspaces::list(&request.input);
    }
    if op == "validate_binding" {
        let workspace = request
            .workspace
            .as_ref()
            .ok_or_else(|| Fault::invalid("Missing workspace"))?;
        return Ok(json!({"feedback_path":workspace.root()?}));
    }
    if op.ends_with("feedback_document") || op == "list_feedback_documents" {
        let root = request
            .workspace
            .as_ref()
            .ok_or_else(|| Fault::invalid("Missing workspace"))?
            .root()?;
        return documents::execute(op, &request.data_dir, &root, &request.input);
    }
    let _lock =
        documents::DirectoryLock::acquire(&request.data_dir, &request.data_dir.join("session"))?;
    let service = api::Service::new()?;
    match op {
        "get_account_status" => Ok(serde_json::to_value(service.account_status().await?)?),
        "list_developer_components" => catalog::execute(&service, &request.input).await,
        "logout" => {
            service.logout().await;
            session::ensure_logged_out()?;
            Ok(json!({"logged_out":true}))
        }
        "login_password" | "login_cookie" => {
            let mut secret = std::env::var("MCDH_FEEDBACK_SECRET")
                .map_err(|_| Fault::invalid("Missing transient login secret"))?;
            let result = if op == "login_password" {
                service
                    .login_password(
                        fault::text(&request.input, "account")?.into(),
                        secret.clone(),
                    )
                    .await
            } else {
                service.login_cookie(secret.clone()).await
            };
            secret.zeroize();
            let outcome = result?;
            if !outcome.persisted {
                return Err(Fault::new(
                    "credential_store_unavailable",
                    "Windows Credential Manager could not save the session; sign-in was not retained",
                ));
            }
            Ok(serde_json::to_value(outcome)?)
        }
        "list_player_comments" | "list_player_feedback" => {
            let workspace = request
                .workspace
                .as_ref()
                .ok_or_else(|| Fault::invalid("Missing workspace"))?;
            workspace.root()?;
            queries::execute(&service, op, &workspace.resource_ids, &request.input).await
        }
        _ => Err(Fault::invalid("Unknown helper operation")),
    }
}
