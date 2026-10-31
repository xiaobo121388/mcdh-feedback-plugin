use std::{collections::HashSet, fmt};

use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;

use super::{AppError, ErrorCode, Page, Service, validate_page};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ComponentPlatform {
    Pe,
    Comp,
}

impl ComponentPlatform {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pe => "pe",
            Self::Comp => "comp",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Pe => "items/categories/pe/",
            Self::Comp => "items/categories/comp/",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DeveloperComponent {
    pub resource_id: String,
    pub resource_name: String,
    pub platform: ComponentPlatform,
    pub status: Option<String>,
}

#[derive(Deserialize)]
struct ComponentListRaw {
    count: usize,
    item: Vec<ComponentRaw>,
}

#[derive(Deserialize)]
struct ComponentRaw {
    #[serde(deserialize_with = "decimal_id")]
    item_id: String,
    item_name: String,
    status: Option<String>,
}

// Never pass an ID through floating point, even if the server changes its JSON type.
fn decimal_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    struct IdVisitor;
    impl<'de> de::Visitor<'de> for IdVisitor {
        type Value = String;
        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a decimal ID string or exact unsigned integer")
        }
        fn visit_str<E: de::Error>(self, value: &str) -> Result<String, E> {
            if value.is_empty() || value.len() > 64 || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(E::custom("invalid component ID"));
            }
            Ok(value.into())
        }
        fn visit_u64<E: de::Error>(self, value: u64) -> Result<String, E> {
            Ok(value.to_string())
        }
        fn visit_i64<E: de::Error>(self, value: i64) -> Result<String, E> {
            u64::try_from(value)
                .map(|value| value.to_string())
                .map_err(|_| E::custom("negative component ID"))
        }
    }
    deserializer.deserialize_any(IdVisitor)
}

fn remote_page_error() -> AppError {
    AppError::new(
        ErrorCode::RemoteApiError,
        "网易组件目录返回的数据或分页不完整，请重试；未将部分结果视为完整目录",
    )
}

pub fn parse_component_page(
    value: Value,
    platform: ComponentPlatform,
    offset: usize,
    limit: usize,
) -> Result<Page<DeveloperComponent>, AppError> {
    validate_page(offset, limit)?;
    let raw: ComponentListRaw = serde_json::from_value(value).map_err(|_| remote_page_error())?;
    let received = raw.item.len();
    let next = offset.checked_add(received).ok_or_else(remote_page_error)?;
    if received > limit || next > raw.count || (received == 0 && offset < raw.count) {
        return Err(remote_page_error());
    }
    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(received);
    for item in raw.item {
        if !seen.insert(item.item_id.clone()) {
            return Err(remote_page_error());
        }
        items.push(DeveloperComponent {
            resource_id: item.item_id,
            resource_name: item.item_name,
            platform,
            status: item.status,
        });
    }
    Ok(Page {
        total: raw.count,
        offset,
        limit,
        has_more: next < raw.count,
        items,
    })
}

impl Service {
    pub async fn list_developer_components(
        &self,
        platform: ComponentPlatform,
        offset: usize,
        limit: usize,
    ) -> Result<Page<DeveloperComponent>, AppError> {
        validate_page(offset, limit)?;
        let token = self
            .session
            .get()
            .await
            .ok_or_else(AppError::auth_required)?;
        // No name, status or type filters: include unpublished and feedback-free works.
        let params = [("start", offset.to_string()), ("span", limit.to_string())];
        let value: Value = self
            .send_read(&token, platform.endpoint(), &params)
            .await
            .map_err(|error| {
                if error.code == ErrorCode::RemoteApiError {
                    // An upstream error body is not trusted to exclude session data.
                    AppError::new(
                        ErrorCode::RemoteApiError,
                        "网易组件目录读取失败，请稍后重试",
                    )
                } else {
                    error
                }
            })?;
        parse_component_page(value, platform, offset, limit)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn official_fields_preserve_full_ids_and_names_without_feedback() {
        let value = serde_json::from_str(
            r#"{"count":3,"item":[
                {"_id":"not-the-resource-id","item_id":"46999999999999999999","item_name":"无评论的中文模组","status":"init"},
                {"item_id":4612345678901234567,"item_name":"已下架组件","status":"offline"},
                {"item_id":"00046123","item_name":"待审核组件","status":"reviewing"}
            ]}"#,
        )
        .unwrap();
        let page = parse_component_page(value, ComponentPlatform::Pe, 0, 100).unwrap();
        assert_eq!(page.items.len(), 3);
        assert!(!page.has_more);
        assert_eq!(page.items[0].resource_id, "46999999999999999999");
        assert_eq!(page.items[0].resource_name, "无评论的中文模组");
        assert_eq!(page.items[1].resource_id, "4612345678901234567");
        assert_eq!(page.items[2].resource_id, "00046123");
        let output = serde_json::to_value(page).unwrap();
        assert!(output["items"][1]["resource_id"].is_string());
    }

    #[test]
    fn short_pages_continue_using_remote_total() {
        let value = json!({"count":4,"item":[{"item_id":"46","item_name":"A"}]});
        let page = parse_component_page(value, ComponentPlatform::Comp, 2, 100).unwrap();
        assert!(page.has_more);
        assert_eq!(page.items[0].platform, ComponentPlatform::Comp);
    }

    #[test]
    fn malformed_ids_and_missing_fields_are_not_silently_dropped() {
        for id in [
            "null",
            "true",
            "-46",
            "4.6e18",
            "46999999999999999999",
            r#""46x""#,
            r#""""#,
        ] {
            let value: Value = serde_json::from_str(&format!(
                r#"{{"count":1,"item":[{{"item_id":{id},"item_name":"A"}}]}}"#
            ))
            .unwrap();
            assert!(parse_component_page(value, ComponentPlatform::Pe, 0, 100).is_err());
        }
        for value in [
            json!({"count":0}),
            json!({"item":[]}),
            json!({"count":1,"item":[{"item_name":"A"}]}),
            json!({"count":1,"item":[{"item_id":"46"}]}),
            json!({"count":1,"item":[{"item_id":"4".repeat(65),"item_name":"A"}]}),
        ] {
            assert!(parse_component_page(value, ComponentPlatform::Pe, 0, 100).is_err());
        }
    }

    #[test]
    fn inconsistent_pages_do_not_report_completion() {
        let item = json!({"item_id":"46","item_name":"A"});
        for (value, offset, limit) in [
            (json!({"count":1,"item":[]}), 0, 100),
            (json!({"count":0,"item":[]}), 1, 100),
            (json!({"count":0,"item":[item.clone()]}), 0, 100),
            (
                json!({"count":2,"item":[item.clone(),item.clone()]}),
                0,
                100,
            ),
            (json!({"count":2,"item":[item.clone(),item.clone()]}), 0, 1),
            (json!({"count":0,"item":[]}), 0, 101),
            (json!({"count":usize::MAX,"item":[item]}), usize::MAX, 100),
        ] {
            assert!(parse_component_page(value, ComponentPlatform::Pe, offset, limit).is_err());
        }
        let empty =
            parse_component_page(json!({"count":0,"item":[]}), ComponentPlatform::Pe, 0, 100)
                .unwrap();
        assert!(!empty.has_more);
    }
}
