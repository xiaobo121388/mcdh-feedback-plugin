// This integration target uses an in-memory session, never the Windows credential store.
#[allow(dead_code, clippy::needless_range_loop)]
#[path = "../src/netease/api.rs"]
mod api;
#[path = "../src/catalog.rs"]
mod catalog;
#[allow(clippy::chunks_exact_to_as_chunks)]
#[path = "../src/netease/crypto.rs"]
mod crypto;
#[path = "../src/netease/error.rs"]
mod error;
#[allow(dead_code)]
#[path = "../src/fault.rs"]
mod fault;
#[path = "../src/netease/models.rs"]
mod models;
#[path = "../src/queries.rs"]
mod queries;

mod session {
    use tokio::sync::RwLock;
    #[derive(Debug)]
    pub struct SessionStore(RwLock<Option<String>>);
    impl SessionStore {
        pub fn new() -> Self {
            Self(RwLock::new(Some("fixture-session-not-a-credential".into())))
        }
        pub fn for_user(_: &str) -> Self {
            Self::new()
        }
        pub async fn get(&self) -> Option<String> {
            self.0.read().await.clone()
        }
        pub async fn install(&self, value: String) -> bool {
            *self.0.write().await = Some(value);
            true
        }
        pub async fn clear(&self) {
            *self.0.write().await = None;
        }
    }
}

use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

struct MockServer {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl MockServer {
    fn start(replies: Vec<(u16, String, Duration)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let record = Arc::clone(&requests);
        let shutdown = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            let mut replies = replies.into_iter();
            while !shutdown.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0_u8; 1024];
                        while !request.ends_with(b"\r\n\r\n") {
                            let count = stream.read(&mut buffer).unwrap();
                            if count == 0 || request.len() > 16 * 1024 {
                                break;
                            }
                            request.extend_from_slice(&buffer[..count]);
                        }
                        record
                            .lock()
                            .unwrap()
                            .push(String::from_utf8(request).unwrap());
                        let (status, body, delay) =
                            replies.next().unwrap_or((500, "{}".into(), Duration::ZERO));
                        thread::sleep(delay);
                        let response = format!(
                            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        // Timeout cases intentionally close the client before the reply.
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("Loopback fixture failed: {error}"),
                }
            }
        });
        Self {
            base,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn service(&self, timeout: Duration) -> api::Service {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(timeout)
            .build()
            .unwrap();
        api::Service::with_test_transport(client, self.base.clone())
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.expect("Loopback fixture worker failed");
        }
    }
}

fn reply(value: Value) -> (u16, String, Duration) {
    (200, value.to_string(), Duration::ZERO)
}

#[tokio::test]
async fn multi_id_comments_and_feedback_preserve_raw_pages_and_exact_selection() {
    let bound = vec!["46999999999999999999".into(), "46999999999999999998".into()];
    let start = "2026-10-30T00:00:00Z";
    let end = "2026-10-31T00:00:00Z";
    let timestamp =
        time::OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
            .unwrap()
            .unix_timestamp();
    let records = json!([
        {"_id":"a","iid":bound[0],"publish_time":timestamp,"create_time":timestamp,"user_comment":"first issue","content":"first issue"},
        {"_id":"b","iid":bound[1],"publish_time":timestamp+1,"create_time":timestamp+1,"user_comment":"second issue","content":"second issue"}
    ]);
    for (operation, endpoint) in [
        ("list_player_comments", "comment"),
        ("list_player_feedback", "feedback"),
    ] {
        let server = MockServer::start(vec![
            reply(
                json!({"status":"ok","data":{"count":3,"data":[{"_id":"foreign","iid":"46999999999999999997","publish_time":timestamp,"create_time":timestamp}]}}),
            ),
            reply(json!({"status":"ok","data":{"count":3,"data":records}})),
            reply(json!({"status":"ok","data":{"count":3,"data":records}})),
        ]);
        let service = server.service(Duration::from_secs(2));
        let first = queries::execute(
            &service,
            operation,
            &bound,
            &json!({"offset":0,"limit":100,"start_date":start,"end_date":end}),
        )
        .await
        .unwrap();
        assert_eq!(first["items"], json!([]));
        assert_eq!(first["next_offset"], 1);
        assert_eq!(first["has_more"], true);
        let second = queries::execute(
            &service,
            operation,
            &bound,
            &json!({"offset":first["next_offset"],"limit":100,"start_date":start,"end_date":end}),
        )
        .await
        .unwrap();
        assert_eq!(second["items"].as_array().unwrap().len(), 2);
        assert_eq!(second["items"][0]["resource_id"], bound[0]);
        assert_eq!(second["items"][1]["resource_id"], bound[1]);
        assert_eq!(second["resource_ids"], json!(bound));
        assert_eq!(second["has_more"], false);
        assert_eq!(second["next_offset"], Value::Null);
        assert_eq!(second["total"], 3);
        let selected = queries::execute(
            &service,
            operation,
            &bound,
            &json!({"offset":1,"limit":100,"resource_id":bound[1]}),
        )
        .await
        .unwrap();
        assert_eq!(selected["items"].as_array().unwrap().len(), 1);
        assert_eq!(selected["items"][0]["id"], "b");
        assert_eq!(selected["resource_ids"], json!([bound[1]]));
        let error = queries::execute(
            &service,
            operation,
            &bound,
            &json!({"resource_id":"46999999999999999997"}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "resource_not_bound");
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        for (request, offset) in requests.iter().zip([0, 1, 1]) {
            assert_eq!(
                request.lines().next().unwrap(),
                format!("GET /items/{endpoint}/pe/?start={offset}&span=100 HTTP/1.1")
            );
        }
    }
}

#[tokio::test]
async fn real_http_catalog_requests_visit_all_pages_and_do_not_send_filters() {
    let server = MockServer::start(vec![
        reply(
            json!({"status":"ok","data":{"count":2,"item":[{"item_id":"46999999999999999999","item_name":"中文未发布组件","status":"init"}]}}),
        ),
        reply(
            json!({"status":"ok","data":{"count":2,"item":[{"item_id":"46123456789012345678","item_name":"无反馈组件","status":"offline"}]}}),
        ),
        reply(
            json!({"status":"ok","data":{"count":1,"item":[{"item_id":"46999999999999999998","item_name":"PC component"}]}}),
        ),
    ]);
    let service = server.service(Duration::from_secs(2));
    let first = catalog::execute(&service, &json!({})).await.unwrap();
    assert_eq!(first["items"][0]["resource_id"], "46999999999999999999");
    assert_eq!(first["items"][0]["resource_name"], "中文未发布组件");
    let second = catalog::execute(&service, &json!({"cursor":first["next_cursor"]}))
        .await
        .unwrap();
    assert_eq!(second["items"][0]["resource_name"], "无反馈组件");
    let third = catalog::execute(&service, &json!({"cursor":second["next_cursor"]}))
        .await
        .unwrap();
    assert_eq!(third["has_more"], false);
    assert_eq!(third["items"][0]["platform"], "comp");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    for (request, expected) in requests.iter().zip([
        "GET /items/categories/pe/?start=0&span=100 HTTP/1.1",
        "GET /items/categories/pe/?start=1&span=100 HTTP/1.1",
        "GET /items/categories/comp/?start=0&span=100 HTTP/1.1",
    ]) {
        assert_eq!(request.lines().next().unwrap(), expected);
        assert!(
            request
                .to_ascii_lowercase()
                .contains("cookie: ntes_sess=fixture-session-not-a-credential")
        );
    }
    assert!(!first.to_string().contains("fixture-session"));
}

#[tokio::test]
async fn expired_sessions_clear_only_in_memory_fixture_and_errors_do_not_echo_bodies() {
    for (status, body, expected) in [
        (401, "{}", "session_expired"),
        (
            200,
            r#"{"status":"no_login","msg":"fixture-session-not-a-credential","data":{}}"#,
            "session_expired",
        ),
        (403, "fixture-session-not-a-credential", "rate_limited"),
        (429, "fixture-session-not-a-credential", "rate_limited"),
        (
            200,
            r#"{"status":"fail","msg":"fixture-session-not-a-credential","data":{}}"#,
            "remote_api_error",
        ),
        (
            200,
            "invalid-json-fixture-session-not-a-credential",
            "remote_api_error",
        ),
        (
            200,
            r#"{"status":"ok","data":{"count":3,"item":[]}}"#,
            "remote_api_error",
        ),
    ] {
        let server = MockServer::start(vec![(status, body.into(), Duration::ZERO)]);
        let service = server.service(Duration::from_secs(2));
        let error = catalog::execute(&service, &json!({})).await.unwrap_err();
        assert_eq!(error.code, expected);
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("fixture-session")
        );
        if expected == "session_expired" {
            assert_eq!(
                catalog::execute(&service, &json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "auth_required"
            );
        }
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn transient_failure_retries_but_timeouts_do_not_return_partial_catalogs() {
    let server = MockServer::start(vec![
        (503, "{}".into(), Duration::ZERO),
        reply(json!({"status":"ok","data":{"count":0,"item":[]}})),
    ]);
    let service = server.service(Duration::from_secs(2));
    let result = catalog::execute(&service, &json!({"platform":"pe"}))
        .await
        .unwrap();
    assert_eq!(result["has_more"], false);
    assert_eq!(server.requests.lock().unwrap().len(), 2);

    let slow = MockServer::start(vec![(200, "{}".into(), Duration::from_millis(500))]);
    let error = catalog::execute(&slow.service(Duration::from_millis(80)), &json!({}))
        .await
        .unwrap_err();
    assert_eq!(error.code, "network_error");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("fixture-session")
    );
}
