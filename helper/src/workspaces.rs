use std::{collections::HashSet, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    fault::{Fault, Result, text},
    paths,
};

#[derive(Debug, Deserialize, Serialize)]
pub struct Workspace {
    pub component_id: String,
    pub component_path: String,
    pub resource_ids: Vec<String>,
    pub feedback_directory: String,
}

impl Workspace {
    pub fn root(&self) -> Result<std::path::PathBuf> {
        validate_ids(&self.resource_ids)?;
        paths::feedback_root(Path::new(&self.component_path), &self.feedback_directory)
    }
}

fn validate_ids(ids: &[String]) -> Result<()> {
    let mut seen = HashSet::new();
    if ids.is_empty()
        || ids.len() > 100
        || ids.iter().any(|id| {
            id.is_empty()
                || id.len() > 64
                || !id.bytes().all(|byte| byte.is_ascii_digit())
                || !seen.insert(id)
        })
    {
        return Err(Fault::invalid(
            "resource_ids must contain 1..100 unique complete numeric ID strings",
        ));
    }
    Ok(())
}

fn normalized_binding(binding: &Value) -> Result<Value> {
    let ids: Vec<String> = match (binding.get("resource_ids"), binding.get("resource_id")) {
        (Some(ids), None) => serde_json::from_value(ids.clone())?,
        (None, Some(Value::String(id))) => vec![id.clone()],
        _ => {
            return Err(Fault::invalid(
                "Provide resource_ids or the legacy resource_id, not both",
            ));
        }
    };
    validate_ids(&ids)?;
    Ok(
        json!({"component_id":text(binding,"component_id")?,"resource_ids":ids,"feedback_directory":text(binding,"feedback_directory")?}),
    )
}

pub fn list(input: &Value) -> Result<Value> {
    let components = input["components"]
        .as_array()
        .ok_or_else(|| Fault::invalid("Missing components"))?;
    let bindings = input["bindings"]
        .as_array()
        .ok_or_else(|| Fault::invalid("Missing bindings"))?
        .iter()
        .map(normalized_binding)
        .collect::<Result<Vec<_>>>()?;
    let mut items = Vec::new();
    for component in components {
        let id = text(component, "id")?;
        let binding = bindings
            .iter()
            .find(|binding| binding["component_id"] == id);
        let mut row = json!({"component_id":id,"name":component["name"],"component_path":component["path"],"kind":component["kind"],"binding":binding,"status":"unbound","feedback_path":null});
        if let Some(binding) = binding {
            let workspace = Workspace {
                component_id: id.into(),
                component_path: text(component, "path")?.into(),
                resource_ids: serde_json::from_value(binding["resource_ids"].clone())?,
                feedback_directory: text(binding, "feedback_directory")?.into(),
            };
            match workspace.root() {
                Ok(root) => {
                    row["status"] = json!(if root.is_dir() {
                        "ready"
                    } else {
                        "directory_missing"
                    });
                    row["feedback_path"] = json!(root);
                }
                Err(error) => {
                    row["status"] = json!(error.code);
                    row["error"] = json!(error.message);
                }
            }
        }
        items.push(row);
    }
    for binding in &bindings {
        if !components
            .iter()
            .any(|component| component["id"] == binding["component_id"])
        {
            items.push(json!({"component_id":binding["component_id"],"name":binding["component_id"],"component_path":null,"binding":binding,"status":"component_missing","feedback_path":null}));
        }
    }
    Ok(json!({"items":items}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directories_may_be_external_and_relative_roots_follow_components() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("模组A");
        let b = temp.path().join("模组B");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let mut workspace = Workspace {
            component_id: "a".into(),
            component_path: a.to_string_lossy().into(),
            resource_ids: vec!["46999999999999999999".into(), "46123456789012345678".into()],
            feedback_directory: "feedback".into(),
        };
        assert_eq!(
            workspace.root().unwrap(),
            std::fs::canonicalize(&a).unwrap().join("feedback")
        );
        workspace.component_path = b.to_string_lossy().into();
        assert_eq!(
            workspace.root().unwrap(),
            std::fs::canonicalize(&b).unwrap().join("feedback")
        );
        workspace.feedback_directory = temp.path().join("外部报告").to_string_lossy().into();
        assert!(workspace.root().unwrap().ends_with("外部报告"));
        let result = list(&json!({"components":[],"bindings":[{"component_id":"missing","resource_id":"46","feedback_directory":"feedback"}]})).unwrap();
        assert_eq!(result["items"][0]["status"], "component_missing");
        assert_eq!(result["items"][0]["binding"]["resource_ids"], json!(["46"]));
    }

    #[test]
    fn lists_each_workspace_once_with_all_ids_and_rejects_invalid_lists() {
        let temp = tempfile::tempdir().unwrap();
        let result = list(&json!({"components":[{"id":"a","name":"shared","path":temp.path(),"kind":"addon"}],"bindings":[{"component_id":"a","resource_ids":["46999999999999999999","46123456789012345678"],"feedback_directory":"feedback"}]})).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["items"][0]["binding"]["resource_ids"],
            json!(["46999999999999999999", "46123456789012345678"])
        );
        assert_eq!(result["items"][0]["status"], "directory_missing");
        for ids in [
            json!([]),
            json!(["46", "46"]),
            json!([46]),
            json!(["46", "x"]),
            json!([" "]),
        ] {
            assert!(
                normalized_binding(
                    &json!({"component_id":"a","resource_ids":ids,"feedback_directory":"feedback"})
                )
                .is_err()
            );
        }
        assert!(normalized_binding(&json!({"component_id":"a","resource_id":"46","resource_ids":["46"],"feedback_directory":"feedback"})).is_err());
        assert!(validate_ids(&(0..101).map(|id| id.to_string()).collect::<Vec<_>>()).is_err());
    }
}
