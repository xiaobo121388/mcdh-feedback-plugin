use serde::Serialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    api::{CommentQuery, FeedbackQuery, Service},
    fault::{Fault, Result},
    models::Page,
};

fn boundary(input: &Value, key: &str) -> Result<Option<OffsetDateTime>> {
    input[key]
        .as_str()
        .map(|value| {
            OffsetDateTime::parse(value, &Rfc3339)
                .map_err(|_| Fault::invalid(format!("{key} must be RFC 3339 with a timezone")))
        })
        .transpose()
}

fn window(input: &Value) -> Result<(Option<OffsetDateTime>, Option<OffsetDateTime>)> {
    let start = boundary(input, "start_date")?;
    let end = boundary(input, "end_date")?;
    if start.zip(end).is_some_and(|(start, end)| start >= end) {
        return Err(Fault::invalid("start_date must be before end_date"));
    }
    Ok((start, end))
}

pub fn filter_page<T: Serialize>(
    page: Page<T>,
    resources: &[&str],
    timestamp: &str,
    input: &Value,
) -> Result<Value> {
    let (start, end) = window(input)?;
    let scanned = page.items.len();
    if page.has_more && scanned == 0 {
        return Err(Fault::new(
            "invalid_remote_page",
            "Remote server returned an empty page with has_more=true",
        ));
    }
    let mut items = Vec::new();
    for item in page.items {
        let item = serde_json::to_value(item)?;
        if !item["resource_id"]
            .as_str()
            .is_some_and(|id| resources.contains(&id))
        {
            continue;
        }
        if start.is_some() || end.is_some() {
            let date = item[timestamp]
                .as_str()
                .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
                .ok_or_else(|| {
                    Fault::new(
                        "invalid_timestamp",
                        "Cannot filter a record with an invalid timestamp",
                    )
                })?;
            if start.is_some_and(|start| date < start) || end.is_some_and(|end| date >= end) {
                continue;
            }
        }
        items.push(item);
    }
    let next = page
        .offset
        .checked_add(scanned)
        .ok_or_else(|| Fault::invalid("Pagination offset overflow"))?;
    Ok(
        json!({"items":items,"total":page.total,"total_scope":"remote_before_resource_and_time_filter","offset":page.offset,"limit":page.limit,"scanned_count":scanned,"has_more":page.has_more,"next_offset":if page.has_more {Some(next)} else {None},"resource_ids":resources,"resource_id":if resources.len()==1 {Some(resources[0])} else {None},"untrusted_player_content":true}),
    )
}

fn selected_resources<'a>(bound: &'a [String], input: &Value) -> Result<Vec<&'a str>> {
    if bound.is_empty() {
        return Err(Fault::invalid("Workspace has no bound resource IDs"));
    }
    match input.get("resource_id") {
        None => Ok(bound.iter().map(String::as_str).collect()),
        Some(value) => {
            let selected = value
                .as_str()
                .ok_or_else(|| Fault::invalid("resource_id must be a string"))?;
            let resource = bound
                .iter()
                .find(|id| id.as_str() == selected)
                .ok_or_else(|| {
                    Fault::new(
                        "resource_not_bound",
                        "The requested resource_id is not bound to this workspace",
                    )
                })?;
            Ok(vec![resource.as_str()])
        }
    }
}

pub async fn execute(
    service: &Service,
    operation: &str,
    bound: &[String],
    input: &Value,
) -> Result<Value> {
    window(input)?;
    let resources = selected_resources(bound, input)?;
    if operation == "list_player_comments" {
        let mut query: CommentQuery = serde_json::from_value(input.clone())?;
        query.start_date = None;
        query.end_date = None;
        filter_page(
            service.list_comments(query).await?,
            &resources,
            "published_at",
            input,
        )
    } else {
        let query: FeedbackQuery = serde_json::from_value(input.clone())?;
        filter_page(
            service.list_feedback(query).await?,
            &resources,
            "created_at",
            input,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn page(items: Vec<Value>) -> Page<Value> {
        Page {
            total: 100,
            offset: 10,
            limit: 100,
            has_more: true,
            items,
        }
    }
    #[test]
    fn filters_full_long_id_and_advances_by_raw_count() {
        let id = "46999999999999999999";
        let result = filter_page(
            page(vec![
                json!({"resource_id":"46999999999999999998"}),
                json!({"resource_id":id}),
            ]),
            &[id],
            "published_at",
            &json!({}),
        )
        .unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["next_offset"], 12);
        let empty = filter_page(
            page(vec![json!({"resource_id":"other"})]),
            &[id],
            "published_at",
            &json!({}),
        )
        .unwrap();
        assert_eq!(empty["items"], json!([]));
        assert_eq!(empty["next_offset"], 11);
        assert_eq!(empty["has_more"], true);
    }
    #[test]
    fn time_window_is_half_open_and_requires_timezone() {
        let query = json!({"start_date":"2026-10-26T12:00:00+08:00","end_date":"2026-10-27T12:00:00+08:00"});
        let values = vec![
            json!({"resource_id":"46","published_at":"2026-10-26T04:00:00Z"}),
            json!({"resource_id":"46","published_at":"2026-10-27T04:00:00Z"}),
        ];
        let result = filter_page(page(values), &["46"], "published_at", &query).unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert!(
            filter_page(
                page(vec![]),
                &["46"],
                "published_at",
                &json!({"start_date":"2026-10-27"})
            )
            .is_err()
        );
        assert!(filter_page(page(vec![]), &["46"], "published_at", &json!({})).is_err());
        assert!(
            filter_page(
                page(vec![json!({"resource_id":"46","published_at":"invalid"})]),
                &["46"],
                "published_at",
                &query
            )
            .is_err()
        );
    }

    #[test]
    fn unions_bound_ids_and_can_select_one_without_changing_raw_pagination() {
        let bound = vec!["46999999999999999999".into(), "46999999999999999998".into()];
        for timestamp in ["published_at", "created_at"] {
            let values = vec![
                json!({"resource_id":bound[0],timestamp:"2026-10-30T04:00:00Z"}),
                json!({"resource_id":"46999999999999999997",timestamp:"2026-10-30T04:00:00Z"}),
                json!({"resource_id":bound[1],timestamp:"2026-10-30T04:00:01Z"}),
            ];
            let input =
                json!({"start_date":"2026-10-30T04:00:00Z","end_date":"2026-10-31T04:00:00Z"});
            let result = filter_page(
                page(values.clone()),
                &selected_resources(&bound, &input).unwrap(),
                timestamp,
                &input,
            )
            .unwrap();
            assert_eq!(result["items"].as_array().unwrap().len(), 2);
            assert_eq!(result["resource_ids"], json!(bound));
            assert_eq!(result["resource_id"], Value::Null);
            assert_eq!(result["next_offset"], 13);
            let input = json!({"resource_id":bound[1]});
            let single = filter_page(
                page(values),
                &selected_resources(&bound, &input).unwrap(),
                timestamp,
                &input,
            )
            .unwrap();
            assert_eq!(single["items"].as_array().unwrap().len(), 1);
            assert_eq!(single["resource_id"], bound[1]);
            assert_eq!(single["next_offset"], 13);
        }
        let error = selected_resources(&bound, &json!({"resource_id":"other"})).unwrap_err();
        assert_eq!(error.code, "resource_not_bound");
        assert!(selected_resources(&bound, &json!({"resource_id":46})).is_err());
        let empty = filter_page(
            page(vec![json!({"resource_id":"other"})]),
            &selected_resources(&bound, &json!({})).unwrap(),
            "published_at",
            &json!({}),
        )
        .unwrap();
        assert_eq!(empty["items"], json!([]));
        assert_eq!(empty["next_offset"], 11);
        assert_eq!(empty["has_more"], true);
    }
}
