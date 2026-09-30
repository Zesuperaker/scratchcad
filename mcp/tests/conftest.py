import json
import os
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastmcp import Client, FastMCP

from scratchcad_mcp.config import Settings
from scratchcad_mcp.server import create_server

# Smallest valid PNG header; the tools pass image bytes through untouched.
PNG = b"\x89PNG\r\n\x1a\nfake"

Handler = Callable[[httpx2.Request], httpx2.Response]


@dataclass
class FakeScratchcad:
    """Stands in for the scratchcad HTTP API and records every request it gets."""

    requests: list[httpx2.Request] = field(default_factory=list)
    handler: Handler | None = None

    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self._handle)

    def _handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.handler is not None:
            return self.handler(request)
        return default_response(request)

    @property
    def last(self) -> httpx2.Request:
        return self.requests[-1]

    @property
    def last_body(self) -> dict[str, Any]:
        body: dict[str, Any] = json.loads(self.last.content)
        return body


def default_response(request: httpx2.Request) -> httpx2.Response:
    """A plausible success response for each scratchcad endpoint."""
    path = request.url.path
    if path == "/v1/scripts/validate":
        return httpx2.Response(200, json={"nodes": 9, "output": ["hi"], "compile_ms": 0.8})
    if path == "/v1/eval":
        return httpx2.Response(200, json={"values": [-1.0], "compute_ms": 0.02})
    if path in ("/v1/raster/2d", "/v1/raster/3d"):
        return httpx2.Response(
            200, content=PNG, headers={"content-type": "image/png", "x-compute-ms": "12.5"}
        )
    if path == "/v1/export/stl":
        return httpx2.Response(
            200,
            content=b"solid-bytes",
            headers={
                "content-type": "model/stl",
                "x-compute-ms": "40.25",
                "x-triangle-count": "1234",
            },
        )
    return httpx2.Response(
        404, json={"error": {"code": "not_found", "message": f"no route {path}"}}
    )


def scratchcad_error(status: int, code: str, message: str) -> Handler:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, json={"error": {"code": code, "message": message}})

    return handler


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the developer's (or the dev container's) SCRATCHCAD_* settings out of tests.

    SCRATCHCAD_BIN is test configuration (see test_integration.py), so it stays.
    """
    for name in list(os.environ):
        if name.startswith("SCRATCHCAD_") and name != "SCRATCHCAD_BIN":
            monkeypatch.delenv(name)


@pytest.fixture
def fake() -> FakeScratchcad:
    return FakeScratchcad()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(url="http://scratchcad.test", output_dir=tmp_path.resolve())


@pytest.fixture
def server(settings: Settings, fake: FakeScratchcad) -> FastMCP:
    return create_server(settings, fake.transport())


@pytest.fixture
async def client(server: FastMCP) -> AsyncIterator[Client[Any]]:
    async with Client(server) as client:
        yield client
