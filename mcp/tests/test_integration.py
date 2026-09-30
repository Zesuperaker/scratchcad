"""End-to-end tests against a real vibecad binary, and of the stdio entry point.

The vibecad tests use the binary at $VIBECAD_BIN when it is set (and fail if it
is missing). Otherwise they look in the sibling server/ crate's target
directory and are skipped when it has not been built.
"""

import base64
import os
import socket
import struct
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastmcp import Client
from fastmcp.client.transports import StdioTransport, StreamableHttpTransport
from mcp_types import ImageContent, TextContent

from vibecad_mcp.config import Settings
from vibecad_mcp.server import create_server

TOKEN = "integration-test-token"
SERVER_DIR = Path(__file__).resolve().parents[2] / "server"

# A 20 x 20 x 20 cube with a 5 mm hole through it along z.
CUBE = """
let block = box(#{ lower: [-10, -10, -10], upper: [10, 10, 10] });
let hole = extrude_z(#{ shape: circle(#{ radius: 2.5 }), lower: -11, upper: 11 });
draw(difference(#{ shape: block, cutout: hole }))
"""


def find_vibecad() -> Path | None:
    explicit = os.environ.get("VIBECAD_BIN")
    if explicit:
        # An explicit path (as CI sets) must exist: fail rather than silently skip.
        if not Path(explicit).is_file():
            pytest.fail(f"VIBECAD_BIN={explicit} does not exist")
        return Path(explicit)
    for kind in ("release", "debug"):
        candidate = SERVER_DIR / "target" / kind / "vibecad"
        if candidate.is_file():
            return candidate
    return None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


@pytest.fixture(scope="module")
def vibecad_url() -> Iterator[str]:
    binary = find_vibecad()
    if binary is None:
        pytest.skip("vibecad binary not built (cargo build --release in server/)")
    port = free_port()
    env = {**os.environ, "VIBECAD_LISTEN": f"127.0.0.1:{port}", "VIBECAD_API_TOKEN": TOKEN}
    process = subprocess.Popen(
        [str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                if httpx2.get(f"{url}/readyz", timeout=1).status_code == 200:
                    break
            except httpx2.TransportError:
                pass
            if process.poll() is not None or time.monotonic() > deadline:
                pytest.fail("vibecad did not start")
            time.sleep(0.05)
        yield url
    finally:
        process.terminate()
        process.wait(timeout=10)


def real_settings(url: str, output_dir: Path, token: str | None = TOKEN) -> Settings:
    return Settings(url=url, api_token=token, output_dir=output_dir.resolve())


pytestmark = pytest.mark.integration


async def test_full_modelling_workflow(vibecad_url: str, tmp_path: Path) -> None:
    async with Client(create_server(real_settings(vibecad_url, tmp_path))) as client:
        validated = await client.call_tool("validate_script", {"script": CUBE})
        assert validated.data["nodes"] > 0

        # Measure: centre of the hole is empty, walls sit at x = ±10.
        measured = await client.call_tool(
            "evaluate",
            {"script": CUBE, "points": [[0, 0, 0], [5, 0, 0], [9.9, 0, 0], [10.1, 0, 0]]},
        )
        hole, solid, inside_wall, outside_wall = measured.data["values"]
        assert hole > 0
        assert solid < 0
        assert inside_wall < 0 < outside_wall

        interval = await client.call_tool(
            "evaluate",
            {"script": CUBE, "mode": "interval", "intervals": [[[20, 30], [20, 30], [20, 30]]]},
        )
        [[lower, _upper]] = interval.data["intervals"]
        assert lower > 0

        for tool, extra in (("render_2d", {}), ("render_3d", {"ssao": False})):
            result = await client.call_tool(
                tool, {"script": CUBE, "width": 64, "height": 64, "half_size": 18, **extra}
            )
            [image] = result.content
            assert isinstance(image, ImageContent)
            assert base64.b64decode(image.data).startswith(b"\x89PNG\r\n\x1a\n")

        exported = await client.call_tool(
            "export_stl", {"script": CUBE, "path": "cube.stl", "half_size": 12, "depth": 5}
        )
        stl = (tmp_path / "cube.stl").read_bytes()
        (triangles,) = struct.unpack_from("<I", stl, 80)
        assert exported.structured_content is not None
        assert exported.structured_content["triangles"] == triangles > 0
        assert exported.structured_content["bytes"] == len(stl) == 84 + 50 * triangles


async def test_real_script_error_is_readable(vibecad_url: str, tmp_path: Path) -> None:
    async with Client(create_server(real_settings(vibecad_url, tmp_path))) as client:
        result = await client.call_tool(
            "validate_script", {"script": "let q = 1 +"}, raise_on_error=False
        )
    assert result.is_error
    [content] = result.content
    assert isinstance(content, TextContent)
    assert content.text.startswith("script_error:")
    assert "line 1" in content.text


async def test_real_limit_error(vibecad_url: str, tmp_path: Path) -> None:
    async with Client(create_server(real_settings(vibecad_url, tmp_path))) as client:
        result = await client.call_tool(
            "render_2d", {"script": CUBE, "width": 100_000, "height": 8}, raise_on_error=False
        )
    assert result.is_error
    [content] = result.content
    assert isinstance(content, TextContent)
    assert "limit_exceeded" in content.text or "bad_request" in content.text


async def test_wrong_token_is_explained(vibecad_url: str, tmp_path: Path) -> None:
    settings = real_settings(vibecad_url, tmp_path, token="not-the-right-token")
    async with Client(create_server(settings)) as client:
        result = await client.call_tool("validate_script", {"script": CUBE}, raise_on_error=False)
    [content] = result.content
    assert isinstance(content, TextContent)
    assert content.text.startswith("unauthorized:")
    assert "VIBECAD_API_TOKEN" in content.text


def stdio_client(env: dict[str, str], cwd: Path) -> Client[Any]:
    transport = StdioTransport(
        command=sys.executable, args=["-m", "vibecad_mcp"], env=env, cwd=str(cwd)
    )
    return Client(transport)


async def test_stdio_entry_point_lists_tools(tmp_path: Path) -> None:
    """The real process speaks MCP over stdio; no vibecad needed to list tools."""
    env = {"PATH": os.environ.get("PATH", ""), "VIBECAD_URL": "http://127.0.0.1:9"}
    async with stdio_client(env, tmp_path) as client:
        names = {tool.name for tool in await client.list_tools()}
        result = await client.call_tool("validate_script", {"script": CUBE}, raise_on_error=False)
    assert names == {"validate_script", "evaluate", "render_2d", "render_3d", "export_stl"}
    assert result.is_error
    [content] = result.content
    assert isinstance(content, TextContent)
    assert "could not reach vibecad" in content.text


async def test_stdio_entry_point_end_to_end(vibecad_url: str, tmp_path: Path) -> None:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "VIBECAD_URL": vibecad_url,
        "VIBECAD_API_TOKEN": TOKEN,
        "VIBECAD_MCP_OUTPUT_DIR": str(tmp_path),
    }
    async with stdio_client(env, tmp_path) as client:
        await client.call_tool(
            "export_stl",
            {"script": CUBE, "path": "out/cube.stl", "half_size": 12, "depth": 4},
        )
    assert (tmp_path / "out" / "cube.stl").stat().st_size > 84


@pytest.fixture
def http_mcp(tmp_path: Path) -> Iterator[str]:
    """The real process in HTTP mode, bound to all interfaces as in the container."""
    port = free_port()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "VIBECAD_URL": "http://127.0.0.1:9",
        "VIBECAD_MCP_TRANSPORT": "http",
        "VIBECAD_MCP_HOST": "0.0.0.0",
        "VIBECAD_MCP_PORT": str(port),
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "vibecad_mcp"],
        env=env,
        cwd=tmp_path,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://localhost:{port}"
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                if httpx2.get(f"{base}/healthz", timeout=1).text == "ok":
                    break
            except httpx2.TransportError:
                pass
            if process.poll() is not None or time.monotonic() > deadline:
                pytest.fail("vibecad-mcp did not start in HTTP mode")
            time.sleep(0.05)
        yield base
    finally:
        process.terminate()
        process.wait(timeout=10)


async def test_http_transport_serves_mcp(http_mcp: str) -> None:
    async with Client(StreamableHttpTransport(f"{http_mcp}/mcp")) as client:
        names = {tool.name for tool in await client.list_tools()}
        result = await client.call_tool("validate_script", {"script": CUBE}, raise_on_error=False)
    assert names == {"validate_script", "evaluate", "render_2d", "render_3d", "export_stl"}
    [content] = result.content
    assert isinstance(content, TextContent)
    assert "could not reach vibecad" in content.text


def test_http_transport_rejects_foreign_host_header(http_mcp: str) -> None:
    """DNS-rebinding protection stays on even though the server binds 0.0.0.0."""
    initialize = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"},
        },
    }
    headers = {"accept": "application/json, text/event-stream"}
    allowed = httpx2.post(f"{http_mcp}/mcp", json=initialize, headers=headers, timeout=5)
    forged = httpx2.post(
        f"{http_mcp}/mcp",
        json=initialize,
        headers={**headers, "host": "attacker.example"},
        timeout=5,
    )
    assert allowed.status_code == 200
    assert forged.status_code in (400, 403, 421)
