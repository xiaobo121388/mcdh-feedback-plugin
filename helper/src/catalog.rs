use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    api::{
        Service,
        developer_components::{ComponentPlatform, DeveloperComponent},
    },
    fault::{Fault, Result},
    models::Page,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Scope {
    All,
    Pe,
    Comp,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Pe => "pe",
            Self::Comp => "comp",
        }
    }
    fn contains(self, platform: ComponentPlatform) -> bool {
        self == Self::All || self.as_str() == platform.as_str()
    }
}

fn default_limit() -> usize {
    100
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    platform: Option<Scope>,
    cursor: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
}

struct Position {
    scope: Scope,
    platform: ComponentPlatform,
    offset: usize,
    limit: usize,
}

impl Query {
    fn resolve(self) -> Result<Position> {
        if !(1..=100).contains(&self.limit) {
            return Err(Fault::invalid("limit must be between 1 and 100"));
        }
        let Some(cursor) = self.cursor else {
            let scope = self.platform.unwrap_or(Scope::All);
            return Ok(Position {
                scope,
                platform: if scope == Scope::Comp {
                    ComponentPlatform::Comp
                } else {
                    ComponentPlatform::Pe
                },
                offset: 0,
                limit: self.limit,
            });
        };
        let invalid = || {
            Fault::invalid(
                "Invalid catalog cursor or mismatched platform; restart without a cursor",
            )
        };
        if cursor.len() > 64 {
            return Err(invalid());
        }
        let mut parts = cursor.split(':');
        if parts.next() != Some("v1") {
            return Err(invalid());
        }
        let scope = match parts.next() {
            Some("all") => Scope::All,
            Some("pe") => Scope::Pe,
            Some("comp") => Scope::Comp,
            _ => return Err(invalid()),
        };
        let platform = match parts.next() {
            Some("pe") => ComponentPlatform::Pe,
            Some("comp") => ComponentPlatform::Comp,
            _ => return Err(invalid()),
        };
        let offset = parts.next().ok_or_else(invalid)?;
        if offset.is_empty() || !offset.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        let offset = offset.parse().map_err(|_| invalid())?;
        if parts.next().is_some()
            || !scope.contains(platform)
            || self.platform.is_some_and(|requested| requested != scope)
        {
            return Err(invalid());
        }
        Ok(Position {
            scope,
            platform,
            offset,
            limit: self.limit,
        })
    }
}

fn finish_page(position: Position, page: Page<DeveloperComponent>) -> Result<Value> {
    let scanned = page.items.len();
    let next = page
        .offset
        .checked_add(scanned)
        .ok_or_else(|| Fault::invalid("Catalog offset overflow"))?;
    // Finishing an empty PE catalog must still advance into the PC catalog.
    let continuation = if page.has_more {
        Some((position.platform, next))
    } else if position.scope == Scope::All && position.platform == ComponentPlatform::Pe {
        Some((ComponentPlatform::Comp, 0))
    } else {
        None
    };
    let next_cursor = continuation.map(|(platform, offset)| {
        format!(
            "v1:{}:{}:{offset}",
            position.scope.as_str(),
            platform.as_str()
        )
    });
    Ok(json!({
        "items":page.items,
        "account_scope":"current_logged_in_developer",
        "requested_platform":position.scope,
        "platform":position.platform,
        "platform_total":page.total,
        "total_scope":"current_platform",
        "offset":page.offset,
        "limit":page.limit,
        "scanned_count":scanned,
        "has_more":next_cursor.is_some(),
        "next_cursor":next_cursor,
        "untrusted_remote_content":true
    }))
}

pub async fn execute(service: &Service, input: &Value) -> Result<Value> {
    let position = serde_json::from_value::<Query>(input.clone())?.resolve()?;
    let page = service
        .list_developer_components(position.platform, position.offset, position.limit)
        .await?;
    finish_page(position, page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::developer_components::parse_component_page;

    fn position(value: Value) -> Result<Position> {
        serde_json::from_value::<Query>(value)?.resolve()
    }

    fn fixture_page(query: Value, total: usize, count: usize) -> Value {
        let position = position(query).unwrap();
        let items: Vec<_> = (position.offset..position.offset + count)
            .map(|index| {
                json!({
                    "item_id":format!("4699999999999999{index:04}"),
                    "item_name":format!("{} component {index}",position.platform.as_str()),
                    "status":if index % 2 == 0 { "init" } else { "offline" }
                })
            })
            .collect();
        let page = parse_component_page(
            json!({"count":total,"item":items}),
            position.platform,
            position.offset,
            position.limit,
        )
        .unwrap();
        finish_page(position, page).unwrap()
    }

    #[test]
    fn all_catalog_pages_return_every_id_name_and_both_platforms() {
        let mut query = json!({});
        let mut records = Vec::new();
        for (total, count) in [(205, 100), (205, 100), (205, 5), (103, 100), (103, 3)] {
            let response = fixture_page(query, total, count);
            records.extend(response["items"].as_array().unwrap().clone());
            query = json!({"cursor":response["next_cursor"]});
            assert_eq!(response["has_more"], !response["next_cursor"].is_null());
            assert_eq!(response["platform_total"], total);
        }
        assert!(query["cursor"].is_null());
        assert_eq!(records.len(), 308);
        for platform in ["pe", "comp"] {
            let subset: Vec<_> = records
                .iter()
                .filter(|item| item["platform"] == platform)
                .collect();
            for (index, item) in subset.iter().enumerate() {
                assert_eq!(item["resource_id"], format!("4699999999999999{index:04}"));
                assert_eq!(
                    item["resource_name"],
                    format!("{platform} component {index}")
                );
            }
        }
    }

    #[test]
    fn empty_pe_page_continues_to_pc_and_empty_pc_finishes() {
        let first = fixture_page(json!({}), 0, 0);
        assert_eq!(first["items"], json!([]));
        assert_eq!(first["has_more"], true);
        assert_eq!(first["next_cursor"], "v1:all:comp:0");
        let last = fixture_page(json!({"cursor":first["next_cursor"]}), 0, 0);
        assert_eq!(last["has_more"], false);
        assert!(last["next_cursor"].is_null());
    }

    #[test]
    fn selected_platform_and_server_short_page_keep_correct_cursor() {
        let first = fixture_page(json!({"platform":"comp"}), 9, 2);
        assert_eq!(first["next_cursor"], "v1:comp:comp:2");
        let second = fixture_page(json!({"cursor":first["next_cursor"],"limit":7}), 9, 7);
        assert_eq!(second["requested_platform"], "comp");
        assert_eq!(second["has_more"], false);
        assert_eq!(
            fixture_page(json!({"platform":"pe"}), 0, 0)["has_more"],
            false
        );
    }

    #[test]
    fn rejects_malformed_cursor_scope_limits_and_unrelated_arguments() {
        for cursor in [
            "",
            "v2:all:pe:0",
            "v1:all:other:0",
            "v1:pe:comp:0",
            "v1:comp:pe:0",
            "v1:all:pe:-1",
            "v1:all:pe:1e2",
            "v1:all:pe:0:extra",
            "v1:all:pe:999999999999999999999999999999",
        ] {
            assert!(position(json!({"cursor":cursor})).is_err());
        }
        for input in [
            json!({"limit":0}),
            json!({"limit":101}),
            json!({"platform":"all","cursor":"v1:pe:pe:0"}),
            json!({"component_id":"local-only"}),
            json!({"developer_id":"someone-else"}),
            json!({"platform":"arbitrary-url"}),
        ] {
            assert!(position(input).is_err());
        }
    }
}
