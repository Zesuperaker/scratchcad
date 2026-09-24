"""Settings for the MCP server, read from environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8080"
# The madcad defaults allow a job to queue for 5 s and then run for 30 s, so
# the HTTP timeout needs some headroom on top of that.
DEFAULT_TIMEOUT_S = 60.0


class ConfigError(ValueError):
    """An environment variable has an invalid value."""


@dataclass(frozen=True)
class Settings:
    url: str = DEFAULT_URL
    api_token: str | None = None
    timeout_s: float = DEFAULT_TIMEOUT_S
    output_dir: Path = Path(".")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env

        url = env.get("MADCAD_URL", "").strip() or DEFAULT_URL
        if not url.startswith(("http://", "https://")):
            raise ConfigError(f"MADCAD_URL must start with http:// or https://, got {url!r}")

        raw_timeout = env.get("MADCAD_MCP_TIMEOUT_S", "").strip()
        timeout_s = DEFAULT_TIMEOUT_S
        if raw_timeout:
            try:
                timeout_s = float(raw_timeout)
            except ValueError:
                raise ConfigError(
                    f"MADCAD_MCP_TIMEOUT_S must be a number, got {raw_timeout!r}"
                ) from None
            if not timeout_s > 0:
                raise ConfigError(f"MADCAD_MCP_TIMEOUT_S must be positive, got {raw_timeout!r}")

        output_dir = Path(env.get("MADCAD_MCP_OUTPUT_DIR", "").strip() or ".")

        return cls(
            url=url.rstrip("/"),
            api_token=env.get("MADCAD_API_TOKEN", "").strip() or None,
            timeout_s=timeout_s,
            output_dir=output_dir.expanduser().resolve(),
        )
