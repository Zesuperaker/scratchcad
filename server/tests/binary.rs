//! End-to-end tests of the `vibecad` executable: startup, serving over TCP,
//! configuration errors and graceful shutdown on signals.

#![cfg(unix)]

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

/// The binary, with any `VIBECAD_*` settings from the test environment removed
/// (other variables, e.g. coverage instrumentation, are kept)
fn command() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_vibecad"));
    for (k, _) in std::env::vars().filter(|(k, _)| k.starts_with("VIBECAD_")) {
        cmd.env_remove(k);
    }
    cmd
}

fn spawn(envs: &[(&str, &str)]) -> (Child, mpsc::Receiver<String>) {
    let mut child = command()
        .env("VIBECAD_LISTEN", "127.0.0.1:0")
        .env("RUST_LOG", "info")
        .envs(envs.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Forward log lines (stdout) to a channel so reads can time out
    let (tx, rx) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    (child, rx)
}

/// Waits for a log line containing `needle`, returning it
fn wait_for(rx: &mpsc::Receiver<String>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) if line.contains(needle) => return line,
            Ok(_) => continue,
            Err(e) => panic!("never saw {needle:?}: {e}"),
        }
    }
}

fn wait_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            panic!("process did not exit");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn http_get(addr: &str, path: &str) -> String {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

fn signal(child: &Child, sig: &str) {
    let ok = Command::new("kill")
        .args([sig, &child.id().to_string()])
        .status()
        .unwrap()
        .success();
    assert!(ok);
}

#[test]
fn serves_and_shuts_down_on_sigterm() {
    let (mut child, rx) = spawn(&[("VIBECAD_LOG_FORMAT", "json")]);
    let line = wait_for(&rx, "listening");
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    let addr = v["fields"]["addr"].as_str().unwrap().to_owned();
    assert_eq!(v["fields"]["auth"], false);
    wait_for(&rx, "unauthenticated");

    let res = http_get(&addr, "/healthz");
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");
    assert!(res.ends_with("ok"));
    // Request logging is on at INFO
    wait_for(&rx, "finished processing request");

    signal(&child, "-TERM");
    wait_for(&rx, "draining");
    wait_for(&rx, "shutdown complete");
    assert!(wait_exit(&mut child).success());
}

#[test]
fn text_logs_auth_and_sigint() {
    let (mut child, rx) = spawn(&[
        ("VIBECAD_API_TOKEN", "0123456789abcdef"),
        ("VIBECAD_RENDER_THREADS", "2"),
    ]);
    let line = wait_for(&rx, "listening");
    assert!(line.contains("render_threads=2"), "{line}");
    assert!(line.contains("auth=true"), "{line}");
    let addr = line
        .split("addr=")
        .nth(1)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned();

    let res = http_get(&addr, "/readyz");
    assert!(res.starts_with("HTTP/1.1 200"), "{res}");

    signal(&child, "-INT");
    wait_for(&rx, "shutdown complete");
    assert!(wait_exit(&mut child).success());
}

#[test]
fn invalid_config_fails_fast() {
    let mut child = command()
        .args(["--max-nodes", "0"])
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let status = wait_exit(&mut child);
    assert!(!status.success());
    let mut err = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut err)
        .unwrap();
    assert!(err.contains("max_nodes must be at least 1"), "{err}");

    // Unbindable address
    let (mut child, _rx) = spawn(&[("VIBECAD_LISTEN", "203.0.113.1:1")]);
    assert!(!wait_exit(&mut child).success());
}
