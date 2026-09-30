from pathlib import Path

import pytest

from scratchcad_mcp.config import DEFAULT_TIMEOUT_S, DEFAULT_URL, ConfigError, Settings


def test_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.url == DEFAULT_URL
    assert settings.api_token is None
    assert settings.timeout_s == DEFAULT_TIMEOUT_S
    assert settings.output_dir == Path(".").resolve()


def test_reads_every_variable(tmp_path: Path) -> None:
    settings = Settings.from_env(
        {
            "SCRATCHCAD_URL": "https://cad.example.com:9000/",
            "SCRATCHCAD_API_TOKEN": "  0123456789abcdef  ",
            "SCRATCHCAD_MCP_TIMEOUT_S": "12.5",
            "SCRATCHCAD_MCP_OUTPUT_DIR": str(tmp_path / "out"),
        }
    )
    assert settings.url == "https://cad.example.com:9000"
    assert settings.api_token == "0123456789abcdef"
    assert settings.timeout_s == 12.5
    assert settings.output_dir == (tmp_path / "out").resolve()


def test_blank_values_fall_back_to_defaults() -> None:
    settings = Settings.from_env(
        {
            "SCRATCHCAD_URL": " ",
            "SCRATCHCAD_API_TOKEN": "",
            "SCRATCHCAD_MCP_TIMEOUT_S": "",
            "SCRATCHCAD_MCP_OUTPUT_DIR": "",
        }
    )
    assert settings == Settings.from_env({})


def test_output_dir_expands_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    settings = Settings.from_env({"SCRATCHCAD_MCP_OUTPUT_DIR": "~/models"})
    assert settings.output_dir == (tmp_path / "models").resolve()


def test_reads_process_environment_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCRATCHCAD_URL", "http://10.0.0.5:8080")
    assert Settings.from_env().url == "http://10.0.0.5:8080"


@pytest.mark.parametrize("url", ["localhost:8080", "ftp://host", "scratchcad"])
def test_rejects_url_without_http_scheme(url: str) -> None:
    with pytest.raises(ConfigError, match="SCRATCHCAD_URL"):
        Settings.from_env({"SCRATCHCAD_URL": url})


@pytest.mark.parametrize(
    ("value", "reason"),
    [("soon", "a number"), ("0", "positive"), ("-3", "positive"), ("nan", "positive")],
)
def test_rejects_bad_timeout(value: str, reason: str) -> None:
    with pytest.raises(ConfigError, match=reason):
        Settings.from_env({"SCRATCHCAD_MCP_TIMEOUT_S": value})


def test_transport_defaults_to_stdio_on_localhost() -> None:
    settings = Settings.from_env({})
    assert settings.transport == "stdio"
    assert (settings.host, settings.port) == ("127.0.0.1", 8000)
    assert settings.allowed_hosts == ("localhost", "127.0.0.1")


def test_reads_http_transport_settings() -> None:
    settings = Settings.from_env(
        {
            "SCRATCHCAD_MCP_TRANSPORT": "http",
            "SCRATCHCAD_MCP_HOST": "0.0.0.0",
            "SCRATCHCAD_MCP_PORT": "9001",
            "SCRATCHCAD_MCP_ALLOWED_HOSTS": " localhost , mcp.internal ,, ",
        }
    )
    assert settings.transport == "http"
    assert (settings.host, settings.port) == ("0.0.0.0", 9001)
    assert settings.allowed_hosts == ("localhost", "mcp.internal")


@pytest.mark.parametrize("value", ["sse", "HTTP", "websocket"])
def test_rejects_unknown_transport(value: str) -> None:
    with pytest.raises(ConfigError, match="stdio or http"):
        Settings.from_env({"SCRATCHCAD_MCP_TRANSPORT": value})


@pytest.mark.parametrize(
    ("value", "reason"),
    [("http", "an integer"), ("80.5", "an integer"), ("0", "between"), ("65536", "between")],
)
def test_rejects_bad_port(value: str, reason: str) -> None:
    with pytest.raises(ConfigError, match=reason):
        Settings.from_env({"SCRATCHCAD_MCP_PORT": value})


def test_rejects_empty_allowed_hosts() -> None:
    with pytest.raises(ConfigError, match="at least one host"):
        Settings.from_env({"SCRATCHCAD_MCP_ALLOWED_HOSTS": " , ,"})
