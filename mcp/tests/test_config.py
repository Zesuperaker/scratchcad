from pathlib import Path

import pytest

from madcad_mcp.config import DEFAULT_TIMEOUT_S, DEFAULT_URL, ConfigError, Settings


def test_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.url == DEFAULT_URL
    assert settings.api_token is None
    assert settings.timeout_s == DEFAULT_TIMEOUT_S
    assert settings.output_dir == Path(".").resolve()


def test_reads_every_variable(tmp_path: Path) -> None:
    settings = Settings.from_env(
        {
            "MADCAD_URL": "https://cad.example.com:9000/",
            "MADCAD_API_TOKEN": "  0123456789abcdef  ",
            "MADCAD_MCP_TIMEOUT_S": "12.5",
            "MADCAD_MCP_OUTPUT_DIR": str(tmp_path / "out"),
        }
    )
    assert settings.url == "https://cad.example.com:9000"
    assert settings.api_token == "0123456789abcdef"
    assert settings.timeout_s == 12.5
    assert settings.output_dir == (tmp_path / "out").resolve()


def test_blank_values_fall_back_to_defaults() -> None:
    settings = Settings.from_env(
        {
            "MADCAD_URL": " ",
            "MADCAD_API_TOKEN": "",
            "MADCAD_MCP_TIMEOUT_S": "",
            "MADCAD_MCP_OUTPUT_DIR": "",
        }
    )
    assert settings == Settings.from_env({})


def test_output_dir_expands_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    settings = Settings.from_env({"MADCAD_MCP_OUTPUT_DIR": "~/models"})
    assert settings.output_dir == (tmp_path / "models").resolve()


def test_reads_process_environment_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MADCAD_URL", "http://10.0.0.5:8080")
    assert Settings.from_env().url == "http://10.0.0.5:8080"


@pytest.mark.parametrize("url", ["localhost:8080", "ftp://host", "madcad"])
def test_rejects_url_without_http_scheme(url: str) -> None:
    with pytest.raises(ConfigError, match="MADCAD_URL"):
        Settings.from_env({"MADCAD_URL": url})


@pytest.mark.parametrize(
    ("value", "reason"),
    [("soon", "a number"), ("0", "positive"), ("-3", "positive"), ("nan", "positive")],
)
def test_rejects_bad_timeout(value: str, reason: str) -> None:
    with pytest.raises(ConfigError, match=reason):
        Settings.from_env({"MADCAD_MCP_TIMEOUT_S": value})
