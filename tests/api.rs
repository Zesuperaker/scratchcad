use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use clap::Parser;
use http_body_util::BodyExt;
use madcad::{AppState, config::Config};
use serde_json::{Value, json};
use tower::ServiceExt;

const SPHERE: &str = "draw(sphere(#{ center: [0.0, 0.0, 0.0], radius: 0.5 }))";

fn app_with(args: &[&str]) -> Router {
    let mut argv = vec!["madcad"];
    argv.extend_from_slice(args);
    let config = Config::parse_from(argv);
    config.validate().unwrap();
    madcad::router(AppState::new(config, fidget::render::ThreadPool::Global))
}

fn app() -> Router {
    app_with(&[])
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&v).unwrap())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}

fn json_body(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap()
}

#[tokio::test]
async fn health_and_readiness() {
    let app = app();
    let (s, h, _) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(s, StatusCode::OK);
    assert!(h.contains_key("x-request-id"));
    let (s, _, b) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(json_body(&b)["status"], "ready");
}

#[tokio::test]
async fn script_lifecycle() {
    let app = app();
    let (s, h, b) = call(
        &app,
        "POST",
        "/v1/scripts",
        Some(json!({ "script": SPHERE })),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    let v = json_body(&b);
    let id = v["script_id"].as_str().unwrap().to_owned();
    assert_eq!(h[header::LOCATION], format!("/v1/scripts/{id}"));
    assert!(v["nodes"].as_u64().unwrap() > 3);

    // Idempotent: posting the same script again hits the cache
    let (s, _, _) = call(
        &app,
        "POST",
        "/v1/scripts",
        Some(json!({ "script": SPHERE })),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let (s, _, b) = call(&app, "GET", &format!("/v1/scripts/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(json_body(&b)["script_id"], id.as_str());

    // Evaluate by id
    let (s, _, b) = call(
        &app,
        "POST",
        "/v1/eval",
        Some(json!({ "script_id": id, "points": [[0, 0, 0], [1, 0, 0]] })),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
    let vals = json_body(&b)["values"].clone();
    assert!((vals[0].as_f64().unwrap() + 0.5).abs() < 1e-5);
    assert!((vals[1].as_f64().unwrap() - 0.5).abs() < 1e-5);

    let (s, _, _) = call(&app, "DELETE", &format!("/v1/scripts/{id}"), None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _, b) = call(&app, "GET", &format!("/v1/scripts/{id}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(json_body(&b)["error"]["code"], "not_found");
}

#[tokio::test]
async fn eval_modes_and_backends() {
    let app = app();
    for evaluator in ["jit", "vm"] {
        let (s, _, b) = call(
            &app,
            "POST",
            "/v1/eval",
            Some(json!({
                "script": "x * x + y * y + z * z",
                "evaluator": evaluator,
                "mode": "gradient",
                "points": [[1, 2, 3]],
            })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        let v = json_body(&b);
        assert_eq!(v["values"][0], 14.0);
        assert_eq!(v["gradients"][0], json!([2.0, 4.0, 6.0]));

        let (s, _, b) = call(
            &app,
            "POST",
            "/v1/eval",
            Some(json!({
                "script": "x + y",
                "evaluator": evaluator,
                "mode": "interval",
                "intervals": [[[0, 1], [2, 3], [0, 0]]],
            })),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(json_body(&b)["intervals"][0], json!([2.0, 4.0]));
    }
}

#[tokio::test]
async fn raster_2d_and_3d_return_png() {
    let app = app();
    for mode in ["mono", "sdf", "debug"] {
        let (s, h, b) = call(
            &app,
            "POST",
            "/v1/raster/2d",
            Some(json!({ "script": "circle(#{ radius: 0.5 })", "width": 64, "height": 32, "mode": mode })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{mode}: {}", String::from_utf8_lossy(&b));
        assert_eq!(h[header::CONTENT_TYPE], "image/png");
        let img = image::load_from_memory(&b).unwrap();
        assert_eq!((img.width(), img.height()), (64, 32));
    }
    for (mode, ssao) in [("heightmap", false), ("normals", false), ("shaded", true)] {
        let (s, _, b) = call(
            &app,
            "POST",
            "/v1/raster/3d",
            Some(json!({
                "script": SPHERE, "width": 48, "height": 48, "mode": mode, "ssao": ssao,
                "rotation": { "yaw": 30, "pitch": -20 }, "perspective": 0.3,
            })),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{mode}: {}", String::from_utf8_lossy(&b));
        let img = image::load_from_memory(&b).unwrap().to_rgba8();
        // Center pixel hits the sphere, corner pixel is background
        assert_eq!(img.get_pixel(24, 24)[3], 255);
        assert_eq!(img.get_pixel(0, 0)[3], 0);
    }
}

#[tokio::test]
async fn stl_export() {
    let app = app();
    let (s, h, b) = call(
        &app,
        "POST",
        "/v1/export/stl",
        Some(json!({ "script": SPHERE, "depth": 5, "evaluator": "vm" })),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
    assert_eq!(h[header::CONTENT_TYPE], "model/stl");
    assert!(
        h[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .starts_with("attachment")
    );
    let tris: usize = h["x-triangle-count"].to_str().unwrap().parse().unwrap();
    assert!(tris > 100);
    // Binary STL layout: 80-byte header, u32 count, 50 bytes per triangle
    let count = u32::from_le_bytes(b[80..84].try_into().unwrap()) as usize;
    assert_eq!(count, tris);
    assert_eq!(b.len(), 84 + 50 * tris);

    // Vertices lie on the sphere (radius 0.5), in model coordinates
    let x = f32::from_le_bytes(b[84 + 12..84 + 16].try_into().unwrap());
    let y = f32::from_le_bytes(b[84 + 16..84 + 20].try_into().unwrap());
    let z = f32::from_le_bytes(b[84 + 20..84 + 24].try_into().unwrap());
    assert!(((x * x + y * y + z * z).sqrt() - 0.5).abs() < 0.05);
}

#[tokio::test]
async fn validation_errors() {
    let app = app();
    let cases = [
        (json!({ "points": [[0, 0, 0]] }), "bad_request"),
        (
            json!({ "script": "x", "script_id": "ab", "points": [[0, 0, 0]] }),
            "bad_request",
        ),
        (json!({ "script": "x", "points": [] }), "bad_request"),
        (
            json!({ "script": "x", "points": [[0, 0, 0]], "bogus": 1 }),
            "invalid_json",
        ),
        (
            json!({ "script": "x", "mode": "interval", "intervals": [[[1, 0], [0, 0], [0, 0]]] }),
            "bad_request",
        ),
        (
            json!({ "script": "let a = ;", "points": [[0, 0, 0]] }),
            "script_error",
        ),
        (
            json!({ "script": "loop {}", "points": [[0, 0, 0]] }),
            "limit_exceeded",
        ),
        (
            json!({ "script_id": "0".repeat(64), "points": [[0, 0, 0]] }),
            "not_found",
        ),
    ];
    for (body, code) in cases {
        let (s, _, b) = call(&app, "POST", "/v1/eval", Some(body.clone())).await;
        assert!(s.is_client_error(), "{body}: {s}");
        assert_eq!(json_body(&b)["error"]["code"], code, "{body}");
    }

    let (s, _, b) = call(
        &app,
        "POST",
        "/v1/raster/2d",
        Some(json!({ "script": "x", "width": 100000, "height": 1 })),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json_body(&b)["error"]["code"], "limit_exceeded");

    let (s, _, _) = call(
        &app,
        "POST",
        "/v1/export/stl",
        Some(json!({ "script": "x", "depth": 30 })),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);

    let (s, _, _) = call(&app, "GET", "/nope", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn body_and_script_limits() {
    let app = app_with(&["--max-body-bytes", "1024", "--max-script-bytes", "512"]);
    let big = "x".repeat(2048);
    let (s, _, b) = call(&app, "POST", "/v1/scripts", Some(json!({ "script": big }))).await;
    assert_eq!(s, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(json_body(&b)["error"]["code"], "payload_too_large");

    let script = format!("x{}", " ".repeat(600));
    let (s, _, b) = call(
        &app,
        "POST",
        "/v1/scripts",
        Some(json!({ "script": script })),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json_body(&b)["error"]["code"], "limit_exceeded");
}

#[tokio::test]
async fn node_limit() {
    let app = app_with(&["--max-nodes", "20"]);
    let script = "let t = x; for i in 0..50 { t = t + y * i; } t";
    let (s, _, b) = call(
        &app,
        "POST",
        "/v1/scripts",
        Some(json!({ "script": script })),
    )
    .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json_body(&b)["error"]["code"], "limit_exceeded");
}

#[tokio::test]
async fn job_timeout_cancels_render() {
    let app = app_with(&["--job-timeout-ms", "50", "--max-image-size-3d", "4096"]);
    // A large, expensive 3D render cannot finish in 50 ms
    let script = "let s = sin(x * 40) * cos(y * 40) + sin(y * 40) * cos(z * 40) \
                  + sin(z * 40) * cos(x * 40); draw(max(abs(s) - 0.2, sqrt(x*x + y*y + z*z) - 0.9))";
    let (s, _, b) = call(
        &app,
        "POST",
        "/v1/raster/3d",
        Some(json!({ "script": script, "width": 4096, "height": 4096, "evaluator": "vm" })),
    )
    .await;
    assert_eq!(s, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(json_body(&b)["error"]["code"], "timeout");
}

#[tokio::test]
async fn bearer_auth() {
    let token = "0123456789abcdef-secret";
    let app = app_with(&["--api-token", token]);

    // Health endpoints stay open for probes
    let (s, _, _) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(s, StatusCode::OK);

    let (s, h, _) = call(&app, "POST", "/v1/scripts", Some(json!({ "script": "x" }))).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(h[header::WWW_AUTHENTICATE], "Bearer");

    let req = |tok: &str| {
        Request::builder()
            .method("POST")
            .uri("/v1/scripts")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {tok}"))
            .body(Body::from(r#"{"script":"x"}"#))
            .unwrap()
    };
    let res = app
        .clone()
        .oneshot(req("wrong-token-wrong-token"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let res = app.clone().oneshot(req(token)).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
}
