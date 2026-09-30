"""Settings for the MCP server, read from environment variables."""

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

DEFAULT_URL = "http://127.0.0.1:8080"
# The vibecad defaults allow a job to queue for 5 s and then run for 30 s, so
# the HTTP timeout needs some headroom on top of that.
DEFAULT_TIMEOUT_S = 60.0
DEFAULT_PORT = 8000
# Host headers accepted in HTTP mode. Setting an allowlist keeps FastMCP's
# DNS-rebinding protection on even when bound to 0.0.0.0 inside a container.
DEFAULT_ALLOWED_HOSTS = ("localhost", "127.0.0.1")

type Transport = Literal["stdio", "http"]


class ConfigError(ValueError):
    """An environment variable has an invalid value."""


@dataclass(frozen=True)
class Settings:
    url: str = DEFAULT_URL
    api_token: str | None = None
    timeout_s: float = DEFAULT_TIMEOUT_S
    output_dir: Path = Path(".")
    transport: Transport = "stdio"
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env

        def get(name: str) -> str:
            return env.get(name, "").strip()

        url = get("VIBECAD_URL") or DEFAULT_URL
        if not url.startswith(("http://", "https://")):
            raise ConfigError(f"VIBECAD_URL must start with http:// or https://, got {url!r}")

        raw_timeout = get("VIBECAD_MCP_TIMEOUT_S")
        timeout_s = DEFAULT_TIMEOUT_S
        if raw_timeout:
            try:
                timeout_s = float(raw_timeout)
            except ValueError:
                raise ConfigError(
                    f"VIBECAD_MCP_TIMEOUT_S must be a number, got {raw_timeout!r}"
                ) from None
            if not timeout_s > 0:
                raise ConfigError(f"VIBECAD_MCP_TIMEOUT_S must be positive, got {raw_timeout!r}")

        transport: Transport
        match get("VIBECAD_MCP_TRANSPORT") or "stdio":
            case "stdio":
                transport = "stdio"
            case "http":
                transport = "http"
            case other:
                raise ConfigError(f"VIBECAD_MCP_TRANSPORT must be stdio or http, got {other!r}")

        raw_port = get("VIBECAD_MCP_PORT")
        port = DEFAULT_PORT
        if raw_port:
            try:
                port = int(raw_port)
            except ValueError:
                raise ConfigError(f"VIBECAD_MCP_PORT must be an integer, got {raw_port!r}") from None
            if not 1 <= port <= 65535:
                raise ConfigError(f"VIBECAD_MCP_PORT must be between 1 and 65535, got {port}")

        raw_hosts = get("VIBECAD_MCP_ALLOWED_HOSTS")
        allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS
        if raw_hosts:
            allowed_hosts = tuple(h.strip() for h in raw_hosts.split(",") if h.strip())
            if not allowed_hosts:
                raise ConfigError("VIBECAD_MCP_ALLOWED_HOSTS must list at least one host")

        return cls(
            url=url.rstrip("/"),
            api_token=get("VIBECAD_API_TOKEN") or None,
            timeout_s=timeout_s,
            output_dir=Path(get("VIBECAD_MCP_OUTPUT_DIR") or ".").expanduser().resolve(),
            transport=transport,
            host=get("VIBECAD_MCP_HOST") or "127.0.0.1",
            port=port,
            allowed_hosts=allowed_hosts,
        )
