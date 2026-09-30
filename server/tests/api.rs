use std::time::Duration;

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode, header},
};
use clap::Parser;
use http_body_util::BodyExt;
use vibecad::{AppState, config::Config};
use serde_json::{Value, json};
use tower::ServiceExt;

const SPHERE: &str = "draw(sphere(#{ center: [0.0, 0.0, 0.0], radius: 0.5 }))";

/// An expensive shape (dense gyroid inside a sphere) for timeout tests
const HEAVY: &str = "let s = sin(x * 40) * cos(y * 40) + sin(y * 40) * cos(z * 40) \
                     + sin(z * 40) * cos(x * 40); \
                     draw(max(abs(s) - 0.2, sqrt(x*x + y*y + z*z) - 0.9))";

fn state_with(args: &[&str]) -> AppState {
    let config = Config::parse_from(std::iter::once("vibecad").chain(args.iter().copied()));
    config.validate().unwrap();
    AppState::new(config, fidget::render::ThreadPool::Global)
}

fn app_with(args: &[&str]) -> Router {
    vibecad::router(state_with(args))
}

fn app() -> Router {
    app_with(&[])
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, bytes)
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(serde_json::to_vec(&v).unwrap())
        }
        None => Body::empty(),
    };
    send(app, req.body(body).unwrap()).await
}

async fn post(app: &Router, uri: &str, body: Value) -> (StatusCode, HeaderMap, Vec<u8>) {
    call(app, "POST", uri, Some(body)).await
}

fn json_body(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(b)))
}

/// Asserts an error response with the given status and error code
fn assert_error(r: &(StatusCode, HeaderMap, Vec<u8>), status: StatusCode, code: &str) {
    assert_eq!(r.0, status, "{}", String::from_utf8_lossy(&r.2));
    assert_eq!(r.1[header::CONTENT_TYPE], "application/json");
    let v = json_body(&r.2);
    assert_eq!(v["error"]["code"], code, "{v}");
    assert!(
        v["error"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty())
    );
}

////////////////////////////////////////////////////////////////////////////////
// Health and middleware

#[tokio::test]
async fn health_and_readiness() {
    let app = app();
    let (s, h, b) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b, b"ok");
    assert!(h.contains_key("x-request-id"));
    assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(h[header::CACHE_CONTROL], "no-store");

    let (s, _, b) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(s, StatusCode::OK);
    let v = json_body(&b);
    assert_eq!(v["status"], "ready");
    assert_eq!(v["active_jobs"], 0);
    assert_eq!(v["job_capacity"], 4);
}

#[tokio::test]
async fn draining_fails_readiness_and_rejects_jobs() {
    let state = state_with(&[]);
    let app = vibecad::router(state.clone());
    state.start_draining();
    assert!(state.is_draining());

    let (s, _, b) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(json_body(&b)["status"], "draining");

    // Liveness is unaffected, but no new work is accepted
    let (s, _, _) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(s, StatusCode::OK);
    let r = post(&app, "/v1/scripts/validate", json!({ "script": "x" })).await;
    assert_error(&r, StatusCode::SERVICE_UNAVAILABLE, "overloaded");
    assert_eq!(r.1[header::RETRY_AFTER], "1");
}

#[tokio::test]
async fn request_id_is_propagated() {
    let req = Request::builder()
        .uri("/healthz")
        .header("x-request-id", "my-trace-id")
        .body(Body::empty())
        .unwrap();
    let (_, h, _) = send(&app(), req).await;
    assert_eq!(h["x-request-id"], "my-trace-id");
}

#[tokio::test]
async fn unknown_routes_and_methods() {
    let app = app();
    let r = call(&app, "GET", "/nope", None).await;
    assert_error(&r, StatusCode::NOT_FOUND, "not_found");

    // The API is stateless: the old script-store routes do not exist
    let r = post(&app, "/v1/scripts", json!({ "script": "x" })).await;
    assert_error(&r, StatusCode::NOT_FOUND, "not_found");

    let (s, _, _) = call(&app, "GET", "/v1/eval", None).await;
    assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
}

////////////////////////////////////////////////////////////////////////////////
// Script validation

#[tokio::test]
async fn validate_script() {
    let app = app();
    let (s, _, b) = post(
        &app,
        "/v1/scripts/validate",
        json!({ "script": "print(\"hello\"); debug(1); sqrt(x*x + y*y) - 1" }),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
    let v = json_body(&b);
    assert!(v["nodes"].as_u64().unwrap() > 3);
    assert!(v["compile_ms"].as_f64().unwrap() >= 0.0);
    assert_eq!(v["output"][0], "hello");
    assert!(v["output"][1].as_str().unwrap().ends_with('1'));
    assert!(v.get("script_id").is_none());

    // Same script twice gives the same answer; nothing is remembered
    let (_, _, b2) = post(&app, "/v1/scripts/validate", json!({ "script": SPHERE })).await;
    let (_, _, b3) = post(&app, "/v1/scripts/validate", json!({ "script": SPHERE })).await;
    assert_eq!(json_body(&b2)["nodes"], json_body(&b3)["nodes"]);
}

#[tokio::test]
async fn script_errors() {
    let app = app();
    let cases = [
        ("let a = ;", "script_error"),                   // parse error
        ("undefined_fn(x)", "script_error"),             // runtime error
        ("1 + 2", "script_error"),                       // not a shape
        ("draw(x); draw(y)", "script_error"),            // double draw
        ("loop {}", "limit_exceeded"),                   // operation budget
        ("fn f(n) { f(n + 1) } f(0)", "limit_exceeded"), // call depth
    ];
    for (script, code) in cases {
        let r = post(&app, "/v1/scripts/validate", json!({ "script": script })).await;
        assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, code);
    }

    // Parse errors report a position
    let (_, _, b) = post(&app, "/v1/scripts/validate", json!({ "script": "x +" })).await;
    assert!(
        json_body(&b)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("line")
    );
}

////////////////////////////////////////////////////////////////////////////////
// Evaluation

#[tokio::test]
async fn eval_values() {
    let (s, _, b) = post(
        &app(),
        "/v1/eval",
        json!({ "script": SPHERE, "points": [[0, 0, 0], [1, 0, 0], [0, 0, -0.5]] }),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
    let v = json_body(&b);
    let vals: Vec<f64> = v["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    for (got, want) in vals.iter().zip([-0.5, 0.5, 0.0]) {
        assert!((got - want).abs() < 1e-5, "{got} vs {want}");
    }
    assert!(v.get("gradients").is_none());
    assert!(v.get("intervals").is_none());
}

#[tokio::test]
async fn eval_modes_and_backends() {
    let app = app();
    for evaluator in ["jit", "vm"] {
        let (s, _, b) = post(
            &app,
            "/v1/eval",
            json!({
                "script": "x * x + y * y + z * z",
                "evaluator": evaluator,
                "mode": "gradient",
                "points": [[1, 2, 3]],
            }),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        let v = json_body(&b);
        assert_eq!(v["values"][0], 14.0);
        assert_eq!(v["gradients"][0], json!([2.0, 4.0, 6.0]));

        let (s, _, b) = post(
            &app,
            "/v1/eval",
            json!({
                "script": "x + y",
                "evaluator": evaluator,
                "mode": "interval",
                "intervals": [[[0, 1], [2, 3], [0, 0]]],
            }),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let v = json_body(&b);
        assert_eq!(v["intervals"][0], json!([2.0, 4.0]));
        assert!(v.get("values").is_none());
    }
}

#[tokio::test]
async fn eval_many_points_spanning_chunks() {
    // More points than one evaluator chunk (16k) to exercise chunking
    let n = 40_000;
    let points: Vec<[f32; 3]> = (0..n).map(|i| [i as f32, 0.0, 0.0]).collect();
    let (s, _, b) = post(
        &app(),
        "/v1/eval",
        json!({ "script": "x", "points": points }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v = json_body(&b);
    let vals = v["values"].as_array().unwrap();
    assert_eq!(vals.len(), n);
    assert_eq!(vals[n - 1], (n - 1) as f64);
}

#[tokio::test]
async fn eval_non_finite_results_are_null() {
    let (s, _, b) = post(
        &app(),
        "/v1/eval",
        json!({ "script": "sqrt(x)", "points": [[-1, 0, 0], [4, 0, 0]] }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let v = json_body(&b);
    assert!(v["values"][0].is_null());
    assert_eq!(v["values"][1], 2.0);
}

////////////////////////////////////////////////////////////////////////////////
// Rasterization

#[tokio::test]
async fn raster_2d_modes() {
    let app = app();
    for mode in ["mono", "sdf", "debug"] {
        for evaluator in ["jit", "vm"] {
            let (s, h, b) = post(
                &app,
                "/v1/raster/2d",
                json!({
                    "script": "circle(#{ radius: 0.5 })", "width": 64, "height": 32,
                    "mode": mode, "evaluator": evaluator,
                }),
            )
            .await;
            assert_eq!(s, StatusCode::OK, "{mode}: {}", String::from_utf8_lossy(&b));
            assert_eq!(h[header::CONTENT_TYPE], "image/png");
            assert!(h["x-compute-ms"].to_str().unwrap().parse::<f64>().is_ok());
            let img = image::load_from_memory(&b).unwrap();
            assert_eq!((img.width(), img.height()), (64, 32));
        }
    }
}

#[tokio::test]
async fn raster_2d_mono_pixels_and_view_transform() {
    let app = app();
    let render = |center: [f32; 2], half_size: f32| {
        post(
            &app,
            "/v1/raster/2d",
            json!({
                "script": "circle(#{ radius: 0.5 })", "width": 32, "height": 32,
                "center": center, "half_size": half_size,
            }),
        )
    };
    // Centered: the middle is inside (white) and the corner outside (black)
    let (_, _, b) = render([0.0, 0.0], 1.0).await;
    let img = image::load_from_memory(&b).unwrap().to_rgba8();
    assert_eq!(img.get_pixel(16, 16).0, [255, 255, 255, 255]);
    assert_eq!(img.get_pixel(0, 0).0, [0, 0, 0, 255]);

    // Moving the view far away leaves only empty space
    let (_, _, b) = render([10.0, 10.0], 1.0).await;
    let img = image::load_from_memory(&b).unwrap().to_rgba8();
    assert!(img.pixels().all(|p| p.0 == [0, 0, 0, 255]));

    // Zooming out shrinks the circle: the corner stays black, the center white
    let (_, _, b) = render([0.0, 0.0], 4.0).await;
    let img = image::load_from_memory(&b).unwrap().to_rgba8();
    let white = img.pixels().filter(|p| p.0[0] == 255).count();
    assert!(white > 0 && white < 32 * 32 / 10, "{white}");
}

#[tokio::test]
async fn raster_3d_modes() {
    let app = app();
    let cases = [
        ("heightmap", false, true),
        ("normals", false, true),
        ("normals", false, false),
        ("shaded", true, true),
        ("shaded", false, false),
    ];
    for (mode, ssao, denoise) in cases {
        let (s, _, b) = post(
            &app,
            "/v1/raster/3d",
            json!({
                "script": SPHERE, "width": 48, "height": 48, "mode": mode,
                "ssao": ssao, "denoise": denoise,
                "rotation": { "yaw": 30, "pitch": -20, "roll": 5 }, "perspective": 0.3,
            }),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{mode}: {}", String::from_utf8_lossy(&b));
        let img = image::load_from_memory(&b).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (48, 48));
        // Center pixel hits the sphere, corner pixel is transparent background
        assert_eq!(img.get_pixel(24, 24)[3], 255, "{mode}");
        assert_eq!(img.get_pixel(0, 0).0, [0, 0, 0, 0], "{mode}");
    }
}

#[tokio::test]
async fn raster_3d_empty_view_and_explicit_depth() {
    let (s, _, b) = post(
        &app(),
        "/v1/raster/3d",
        json!({
            "script": SPHERE, "width": 16, "height": 8, "depth": 4,
            "mode": "heightmap", "center": [10, 10, 10], "evaluator": "vm",
        }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let img = image::load_from_memory(&b).unwrap().to_rgba8();
    assert_eq!(img.dimensions(), (16, 8));
    assert!(img.pixels().all(|p| p.0 == [0, 0, 0, 0]));
}

////////////////////////////////////////////////////////////////////////////////
// STL export

fn stl_vertex(b: &[u8], tri: usize, vert: usize) -> [f32; 3] {
    let at = 84 + 50 * tri + 12 + 12 * vert;
    let f = |o: usize| f32::from_le_bytes(b[at + o..at + o + 4].try_into().unwrap());
    [f(0), f(4), f(8)]
}

#[tokio::test]
async fn stl_export() {
    let app = app();
    for evaluator in ["jit", "vm"] {
        let (s, h, b) = post(
            &app,
            "/v1/export/stl",
            json!({ "script": SPHERE, "depth": 5, "evaluator": evaluator }),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
        assert_eq!(h[header::CONTENT_TYPE], "model/stl");
        assert_eq!(
            h[header::CONTENT_DISPOSITION],
            "attachment; filename=\"shape.stl\""
        );
        let tris: usize = h["x-triangle-count"].to_str().unwrap().parse().unwrap();
        assert!(tris > 100);
        // Binary STL layout: 80-byte header, u32 count, 50 bytes per triangle
        let count = u32::from_le_bytes(b[80..84].try_into().unwrap()) as usize;
        assert_eq!(count, tris);
        assert_eq!(b.len(), 84 + 50 * tris);

        // Every vertex lies on the sphere (radius 0.5), in model coordinates
        for t in 0..tris {
            let [x, y, z] = stl_vertex(&b, t, 0);
            assert!(((x * x + y * y + z * z).sqrt() - 0.5).abs() < 0.05);
        }
    }
}

#[tokio::test]
async fn stl_region_transform() {
    // A sphere at (5, 0, 0), meshed through a region centered on it
    let script = "draw(sphere(#{ center: [5.0, 0.0, 0.0], radius: 1.0 }))";
    let (s, h, b) = post(
        &app(),
        "/v1/export/stl",
        json!({ "script": script, "depth": 4, "center": [5, 0, 0], "half_size": 2 }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let tris: usize = h["x-triangle-count"].to_str().unwrap().parse().unwrap();
    assert!(tris > 0);
    for t in 0..tris {
        let [x, y, z] = stl_vertex(&b, t, 1);
        let r = ((x - 5.0).powi(2) + y * y + z * z).sqrt();
        assert!((r - 1.0).abs() < 0.1, "{r}");
    }

    // The same sphere is invisible from the default region at the origin
    let (s, h, b) = post(
        &app(),
        "/v1/export/stl",
        json!({ "script": script, "depth": 4 }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(h["x-triangle-count"], "0");
    assert_eq!(b.len(), 84);
}

#[tokio::test]
async fn stl_triangle_limit() {
    let app = app_with(&["--max-mesh-triangles", "10"]);
    let r = post(
        &app,
        "/v1/export/stl",
        json!({ "script": SPHERE, "depth": 5 }),
    )
    .await;
    assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded");
}

////////////////////////////////////////////////////////////////////////////////
// Request validation and limits

#[tokio::test]
async fn eval_validation_errors() {
    let app = app();
    let cases = [
        (json!({ "points": [[0, 0, 0]] }), "invalid_json"), // missing script
        (
            json!({ "script": "x", "script_id": "ab", "points": [[0, 0, 0]] }),
            "invalid_json",
        ),
        (json!({ "script": "x", "points": [] }), "bad_request"),
        (json!({ "script": "x", "points": [[0, 0]] }), "invalid_json"),
        (
            json!({ "script": "x", "points": [[0, 0, 0]], "bogus": 1 }),
            "invalid_json",
        ),
        (
            json!({ "script": "x", "points": [[0, 0, 0]], "evaluator": "gpu" }),
            "invalid_json",
        ),
        (
            json!({ "script": "x", "points": [[0, 0, 0]], "mode": "nope" }),
            "invalid_json",
        ),
        (
            json!({ "script": "x", "points": [[0, 0, 0]], "intervals": [[[0, 1], [0, 1], [0, 1]]] }),
            "bad_request",
        ),
        (
            json!({ "script": "x", "mode": "interval", "points": [[0, 0, 0]] }),
            "bad_request",
        ),
        (
            json!({ "script": "x", "mode": "interval", "intervals": [[[1, 0], [0, 0], [0, 0]]] }),
            "bad_request",
        ),
    ];
    for (body, code) in cases {
        let r = post(&app, "/v1/eval", body.clone()).await;
        assert_error(&r, StatusCode::BAD_REQUEST, code);
    }
    let r = post(
        &app,
        "/v1/eval",
        json!({ "script": "let a = ;", "points": [[0, 0, 0]] }),
    )
    .await;
    assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "script_error");
}

#[tokio::test]
async fn raster_and_stl_validation_errors() {
    let app = app();
    let bad_request = [
        (
            "/v1/raster/2d",
            json!({ "script": "x", "width": 8, "height": 8, "half_size": 0 }),
        ),
        (
            "/v1/raster/2d",
            json!({ "script": "x", "width": 8, "height": 8, "half_size": -1 }),
        ),
        (
            "/v1/raster/3d",
            json!({ "script": "x", "width": 8, "height": 8, "perspective": 2 }),
        ),
        (
            "/v1/raster/3d",
            json!({ "script": "x", "width": 8, "height": 8, "perspective": -0.1 }),
        ),
        (
            "/v1/raster/3d",
            json!({ "script": "x", "width": 8, "height": 8, "mode": "normals", "ssao": true }),
        ),
        ("/v1/export/stl", json!({ "script": "x", "half_size": 0 })),
    ];
    for (uri, body) in bad_request {
        let r = post(&app, uri, body.clone()).await;
        assert_error(&r, StatusCode::BAD_REQUEST, "bad_request");
    }

    let too_big = [
        (
            "/v1/raster/2d",
            json!({ "script": "x", "width": 100000, "height": 1 }),
        ),
        (
            "/v1/raster/2d",
            json!({ "script": "x", "width": 0, "height": 1 }),
        ),
        (
            "/v1/raster/3d",
            json!({ "script": "x", "width": 8, "height": 8, "depth": 100000 }),
        ),
        (
            "/v1/raster/3d",
            json!({ "script": "x", "width": 8, "height": 3000 }),
        ),
        ("/v1/export/stl", json!({ "script": "x", "depth": 30 })),
        ("/v1/export/stl", json!({ "script": "x", "depth": 0 })),
    ];
    for (uri, body) in too_big {
        let r = post(&app, uri, body.clone()).await;
        assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded");
    }

    // Wrong types / missing fields are JSON errors
    let r = post(&app, "/v1/raster/2d", json!({ "script": "x", "width": 8 })).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "invalid_json");
    let r = post(
        &app,
        "/v1/raster/3d",
        json!({ "script": "x", "width": 8, "height": 8, "rotation": { "spin": 1 } }),
    )
    .await;
    assert_error(&r, StatusCode::BAD_REQUEST, "invalid_json");
}

#[tokio::test]
async fn malformed_bodies() {
    let app = app();
    let raw = |ct: Option<&str>, body: &str| {
        let mut r = Request::builder().method("POST").uri("/v1/eval");
        if let Some(ct) = ct {
            r = r.header(header::CONTENT_TYPE, ct);
        }
        r.body(Body::from(body.to_owned())).unwrap()
    };
    let r = send(&app, raw(None, r#"{"script":"x"}"#)).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "bad_request");
    let r = send(&app, raw(Some("application/json"), "{not json")).await;
    assert_error(&r, StatusCode::BAD_REQUEST, "invalid_json");
    // JSON cannot carry NaN; the literal is a syntax error
    let r = send(
        &app,
        raw(
            Some("application/json"),
            r#"{"script":"x","points":[[NaN,0,0]]}"#,
        ),
    )
    .await;
    assert_error(&r, StatusCode::BAD_REQUEST, "invalid_json");
}

#[tokio::test]
async fn body_and_script_limits() {
    let app = app_with(&["--max-body-bytes", "1024", "--max-script-bytes", "512"]);
    let big = "x".repeat(2048);
    let r = post(&app, "/v1/scripts/validate", json!({ "script": big })).await;
    assert_error(&r, StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");

    // Every endpoint enforces the script size limit
    let script = format!("x{}", " ".repeat(600));
    let bodies = [
        ("/v1/scripts/validate", json!({ "script": script })),
        (
            "/v1/eval",
            json!({ "script": script, "points": [[0, 0, 0]] }),
        ),
        (
            "/v1/raster/2d",
            json!({ "script": script, "width": 8, "height": 8 }),
        ),
        (
            "/v1/raster/3d",
            json!({ "script": script, "width": 8, "height": 8 }),
        ),
        ("/v1/export/stl", json!({ "script": script })),
    ];
    for (uri, body) in bodies {
        let r = post(&app, uri, body).await;
        assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded");
    }
}

#[tokio::test]
async fn eval_point_limit() {
    let app = app_with(&["--max-eval-points", "2"]);
    let r = post(
        &app,
        "/v1/eval",
        json!({ "script": "x", "points": [[0, 0, 0], [0, 0, 0], [0, 0, 0]] }),
    )
    .await;
    assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded");
}

#[tokio::test]
async fn node_limit() {
    let app = app_with(&["--max-nodes", "20"]);
    let script = "let t = x; for i in 0..50 { t = t + y * i; } t";
    let r = post(&app, "/v1/scripts/validate", json!({ "script": script })).await;
    assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded");
}

#[tokio::test]
async fn operation_limit_is_configurable() {
    let script = "let t = x; for i in 0..200 { t = t + 1; } t";
    let r = post(
        &app_with(&["--max-script-operations", "100"]),
        "/v1/scripts/validate",
        json!({ "script": script }),
    )
    .await;
    assert_error(&r, StatusCode::UNPROCESSABLE_ENTITY, "limit_exceeded");
    let (s, _, _) = post(&app(), "/v1/scripts/validate", json!({ "script": script })).await;
    assert_eq!(s, StatusCode::OK);
}

////////////////////////////////////////////////////////////////////////////////
// Timeouts and load shedding

#[tokio::test]
async fn job_timeout_cancels_render() {
    let app = app_with(&["--job-timeout-ms", "50"]);
    let r = post(
        &app,
        "/v1/raster/3d",
        json!({ "script": HEAVY, "width": 2048, "height": 2048, "evaluator": "vm" }),
    )
    .await;
    assert_error(&r, StatusCode::GATEWAY_TIMEOUT, "timeout");
}

#[tokio::test]
async fn job_timeout_cancels_mesh() {
    let app = app_with(&["--job-timeout-ms", "50"]);
    let r = post(
        &app,
        "/v1/export/stl",
        json!({ "script": HEAVY, "depth": 8, "evaluator": "vm" }),
    )
    .await;
    assert_error(&r, StatusCode::GATEWAY_TIMEOUT, "timeout");
}

#[tokio::test]
async fn job_timeout_cancels_script() {
    let app = app_with(&[
        "--job-timeout-ms",
        "50",
        "--max-script-operations",
        "1000000000000",
    ]);
    let r = post(&app, "/v1/scripts/validate", json!({ "script": "loop {}" })).await;
    assert_error(&r, StatusCode::GATEWAY_TIMEOUT, "timeout");
}

#[tokio::test]
async fn overload_returns_503() {
    let app = app_with(&[
        "--max-concurrent-jobs",
        "1",
        "--queue-timeout-ms",
        "20",
        "--job-timeout-ms",
        "2000",
    ]);
    let busy = {
        let app = app.clone();
        tokio::spawn(async move {
            post(
                &app,
                "/v1/raster/3d",
                json!({ "script": HEAVY, "width": 2048, "height": 2048, "evaluator": "vm" }),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let r = post(&app, "/v1/scripts/validate", json!({ "script": "x" })).await;
    assert_error(&r, StatusCode::SERVICE_UNAVAILABLE, "overloaded");
    assert_eq!(r.1[header::RETRY_AFTER], "1");
    busy.abort();
}

////////////////////////////////////////////////////////////////////////////////
// Authentication

#[tokio::test]
async fn bearer_auth() {
    let token = "0123456789abcdef-secret";
    let app = app_with(&["--api-token", token]);

    // Health endpoints stay open for probes
    let (s, _, _) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(s, StatusCode::OK);

    let r = post(&app, "/v1/scripts/validate", json!({ "script": "x" })).await;
    assert_error(&r, StatusCode::UNAUTHORIZED, "unauthorized");
    assert_eq!(r.1[header::WWW_AUTHENTICATE], "Bearer");

    let req = |auth: &str| {
        Request::builder()
            .method("POST")
            .uri("/v1/scripts/validate")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, auth)
            .body(Body::from(r#"{"script":"x"}"#))
            .unwrap()
    };
    for bad in [
        "Bearer wrong-token-wrong-token",
        token,
        "Basic abc",
        &format!("Bearer {token}x"),
    ] {
        let (s, _, _) = send(&app, req(bad)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{bad}");
    }
    let (s, _, _) = send(&app, req(&format!("Bearer {token}"))).await;
    assert_eq!(s, StatusCode::OK);
}
