"""The MCP surface, exercised through a real MCP client session in memory."""

import base64
import runpy
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastmcp import Client, FastMCP
from mcp_types import ImageContent, TextContent

from vibecad_mcp import server as server_module
from vibecad_mcp.config import Settings
from vibecad_mcp.server import GUIDE, create_server

from .conftest import PNG, FakeVibecad, vibecad_error

SCRIPT = "draw(sphere(#{ radius: 0.5 }))"
TOOLS = {"validate_script", "evaluate", "render_2d", "render_3d", "export_stl"}


async def call_error(client: Client[Any], tool: str, arguments: dict[str, Any]) -> str:
    """Call a tool that is expected to fail and return the error text the model sees."""
    result = await client.call_tool(tool, arguments, raise_on_error=False)
    assert result.is_error
    [content] = result.content
    assert isinstance(content, TextContent)
    return content.text


# --- discovery -------------------------------------------------------------


async def test_lists_exactly_the_five_tools(client: Client[Any]) -> None:
    assert {tool.name for tool in await client.list_tools()} == TOOLS


async def test_instructions_carry_the_scripting_guide(client: Client[Any]) -> None:
    assert client.instructions == GUIDE
    for needle in ("draw(shape)", "difference(", "degrees", "half_size", "negative"):
        assert needle in GUIDE


async def test_every_tool_documents_every_parameter(client: Client[Any]) -> None:
    for tool in await client.list_tools():
        assert tool.description, tool.name
        properties = tool.input_schema["properties"]
        assert "ctx" not in properties
        assert "script" in tool.input_schema["required"]
        for name, schema in properties.items():
            assert schema.get("description"), f"{tool.name}.{name} has no description"


async def test_annotations_mark_only_export_as_writing(client: Client[Any]) -> None:
    tools = {tool.name: tool for tool in await client.list_tools()}
    for name in TOOLS - {"export_stl"}:
        annotations = tools[name].annotations
        assert annotations is not None
        assert annotations.read_only_hint is True
        assert annotations.idempotent_hint is True
    export = tools["export_stl"].annotations
    assert export is not None
    assert export.read_only_hint is False
    assert export.destructive_hint is True


async def test_schemas_carry_the_input_constraints(client: Client[Any]) -> None:
    tools = {tool.name: tool.input_schema["properties"] for tool in await client.list_tools()}
    assert tools["render_3d"]["perspective"]["maximum"] == 1
    assert tools["render_3d"]["width"]["minimum"] == 1
    assert tools["render_3d"]["mode"]["enum"] == ["shaded", "normals", "heightmap"]
    assert tools["render_2d"]["mode"]["enum"] == ["mono", "sdf", "debug"]
    assert tools["evaluate"]["mode"]["enum"] == ["value", "gradient", "interval"]
    assert tools["export_stl"]["half_size"]["exclusiveMinimum"] == 0
    assert set(tools["export_stl"]) >= {"path", "overwrite", "depth"}


# --- validate_script --------------------------------------------------------


async def test_validate_script(client: Client[Any], fake: FakeVibecad) -> None:
    result = await client.call_tool("validate_script", {"script": SCRIPT})
    assert result.data == {"nodes": 9, "output": ["hi"], "compile_ms": 0.8}
    assert fake.last.url.path == "/v1/scripts/validate"
    assert fake.last_body == {"script": SCRIPT}


async def test_script_errors_reach_the_model_verbatim(
    client: Client[Any], fake: FakeVibecad
) -> None:
    fake.handler = vibecad_error(
        422, "script_error", "script error: Script is incomplete (line 1, position 12)"
    )
    text = await call_error(client, "validate_script", {"script": "let q = 1 +"})
    assert text == "script_error: script error: Script is incomplete (line 1, position 12)"


# --- evaluate ---------------------------------------------------------------


async def test_evaluate_defaults_to_value_mode(client: Client[Any], fake: FakeVibecad) -> None:
    result = await client.call_tool("evaluate", {"script": SCRIPT, "points": [[0, 0, 0]]})
    assert result.data == {"values": [-1.0], "compute_ms": 0.02}
    assert fake.last.url.path == "/v1/eval"
    assert fake.last_body == {"script": SCRIPT, "mode": "value", "points": [[0.0, 0.0, 0.0]]}


async def test_evaluate_gradient_and_evaluator(client: Client[Any], fake: FakeVibecad) -> None:
    await client.call_tool(
        "evaluate",
        {"script": SCRIPT, "mode": "gradient", "points": [[1, 2, 3]], "evaluator": "vm"},
    )
    assert fake.last_body == {
        "script": SCRIPT,
        "mode": "gradient",
        "points": [[1.0, 2.0, 3.0]],
        "evaluator": "vm",
    }


async def test_evaluate_interval_mode(client: Client[Any], fake: FakeVibecad) -> None:
    box = [[-1, 1], [-1, 1], [-1, 1]]
    await client.call_tool("evaluate", {"script": SCRIPT, "mode": "interval", "intervals": [box]})
    assert fake.last_body == {
        "script": SCRIPT,
        "mode": "interval",
        "intervals": [[[-1.0, 1.0], [-1.0, 1.0], [-1.0, 1.0]]],
    }


async def test_evaluate_rejects_malformed_points(client: Client[Any], fake: FakeVibecad) -> None:
    text = await call_error(client, "evaluate", {"script": SCRIPT, "points": [[1, 2]]})
    assert "points" in text
    assert fake.requests == []


# --- render_2d --------------------------------------------------------------


async def test_render_2d_returns_png(client: Client[Any], fake: FakeVibecad) -> None:
    result = await client.call_tool("render_2d", {"script": SCRIPT})
    [content] = result.content
    assert isinstance(content, ImageContent)
    assert content.mime_type == "image/png"
    assert base64.b64decode(content.data) == PNG
    assert fake.last.url.path == "/v1/raster/2d"
    assert fake.last_body == {
        "script": SCRIPT,
        "width": 512,
        "height": 512,
        "mode": "mono",
        "center": [0.0, 0.0],
        "half_size": 1.0,
    }


async def test_render_2d_passes_every_option(client: Client[Any], fake: FakeVibecad) -> None:
    await client.call_tool(
        "render_2d",
        {
            "script": SCRIPT,
            "width": 64,
            "height": 32,
            "mode": "sdf",
            "center": [1, -1],
            "half_size": 3,
            "evaluator": "jit",
        },
    )
    assert fake.last_body == {
        "script": SCRIPT,
        "width": 64,
        "height": 32,
        "mode": "sdf",
        "center": [1.0, -1.0],
        "half_size": 3.0,
        "evaluator": "jit",
    }


# --- render_3d --------------------------------------------------------------


async def test_render_3d_returns_png_with_a_three_quarter_view(
    client: Client[Any], fake: FakeVibecad
) -> None:
    result = await client.call_tool("render_3d", {"script": SCRIPT})
    [content] = result.content
    assert isinstance(content, ImageContent)
    assert base64.b64decode(content.data) == PNG
    assert fake.last.url.path == "/v1/raster/3d"
    assert fake.last_body == {
        "script": SCRIPT,
        "width": 512,
        "height": 512,
        "mode": "shaded",
        "ssao": True,
        "center": [0.0, 0.0, 0.0],
        "half_size": 1.0,
        "rotation": {"yaw": 30.0, "pitch": -20.0, "roll": 0.0},
        "perspective": 0.0,
    }


async def test_render_3d_passes_every_option(client: Client[Any], fake: FakeVibecad) -> None:
    await client.call_tool(
        "render_3d",
        {
            "script": SCRIPT,
            "width": 256,
            "height": 128,
            "depth": 64,
            "yaw": 90,
            "pitch": 45,
            "roll": 10,
            "center": [1, 2, 3],
            "half_size": 20,
            "ssao": False,
            "perspective": 0.5,
            "evaluator": "vm",
        },
    )
    assert fake.last_body == {
        "script": SCRIPT,
        "width": 256,
        "height": 128,
        "depth": 64,
        "mode": "shaded",
        "ssao": False,
        "center": [1.0, 2.0, 3.0],
        "half_size": 20.0,
        "rotation": {"yaw": 90.0, "pitch": 45.0, "roll": 10.0},
        "perspective": 0.5,
        "evaluator": "vm",
    }


@pytest.mark.parametrize("mode", ["normals", "heightmap"])
async def test_render_3d_omits_ssao_outside_shaded_mode(
    client: Client[Any], fake: FakeVibecad, mode: str
) -> None:
    await client.call_tool("render_3d", {"script": SCRIPT, "mode": mode, "ssao": True})
    assert fake.last_body["mode"] == mode
    assert "ssao" not in fake.last_body


@pytest.mark.parametrize(
    "arguments",
    [
        {"width": 0},
        {"height": -5},
        {"perspective": 1.5},
        {"perspective": -0.1},
        {"half_size": 0},
        {"depth": 0},
        {"mode": "wireframe"},
        {"evaluator": "gpu"},
        {"center": [1, 2]},
        {"unknown": 1},
    ],
)
async def test_render_3d_rejects_invalid_arguments_locally(
    client: Client[Any], fake: FakeVibecad, arguments: dict[str, Any]
) -> None:
    await call_error(client, "render_3d", {"script": SCRIPT, **arguments})
    assert fake.requests == []


async def test_missing_script_is_rejected(client: Client[Any], fake: FakeVibecad) -> None:
    text = await call_error(client, "render_3d", {})
    assert "script" in text
    assert fake.requests == []


# --- export_stl -------------------------------------------------------------


async def test_export_stl_writes_the_file(
    client: Client[Any], fake: FakeVibecad, settings: Settings
) -> None:
    result = await client.call_tool("export_stl", {"script": SCRIPT, "path": "part.stl"})
    target = settings.output_dir / "part.stl"
    assert result.structured_content == {
        "path": str(target),
        "bytes": len(b"solid-bytes"),
        "triangles": 1234,
        "compute_ms": 40.25,
    }
    assert target.read_bytes() == b"solid-bytes"
    assert fake.last.url.path == "/v1/export/stl"
    assert fake.last_body == {
        "script": SCRIPT,
        "center": [0.0, 0.0, 0.0],
        "half_size": 1.0,
        "depth": 6,
    }


async def test_export_stl_passes_every_option(client: Client[Any], fake: FakeVibecad) -> None:
    await client.call_tool(
        "export_stl",
        {
            "script": SCRIPT,
            "path": "p.stl",
            "center": [1, 1, 1],
            "half_size": 15,
            "depth": 8,
            "evaluator": "vm",
        },
    )
    assert fake.last_body == {
        "script": SCRIPT,
        "center": [1.0, 1.0, 1.0],
        "half_size": 15.0,
        "depth": 8,
        "evaluator": "vm",
    }


async def test_export_stl_creates_subdirectories(client: Client[Any], settings: Settings) -> None:
    await client.call_tool("export_stl", {"script": SCRIPT, "path": "parts/v2/bracket.STL"})
    assert (settings.output_dir / "parts/v2/bracket.STL").read_bytes() == b"solid-bytes"


async def test_export_stl_accepts_absolute_path_inside_output_dir(
    client: Client[Any], settings: Settings
) -> None:
    target = settings.output_dir / "abs.stl"
    await client.call_tool("export_stl", {"script": SCRIPT, "path": str(target)})
    assert target.exists()


async def test_export_stl_refuses_to_overwrite_by_default(
    client: Client[Any], fake: FakeVibecad, settings: Settings
) -> None:
    target = settings.output_dir / "part.stl"
    target.write_bytes(b"original")
    text = await call_error(client, "export_stl", {"script": SCRIPT, "path": "part.stl"})
    assert "already exists" in text
    assert "overwrite" in text
    assert target.read_bytes() == b"original"
    assert fake.requests == []

    await client.call_tool("export_stl", {"script": SCRIPT, "path": "part.stl", "overwrite": True})
    assert target.read_bytes() == b"solid-bytes"


@pytest.mark.parametrize(
    ("path", "message"),
    [
        ("../escape.stl", "inside the output directory"),
        ("/etc/evil.stl", "inside the output directory"),
        ("sub/../../escape.stl", "inside the output directory"),
        ("part.obj", "end in .stl"),
        ("part", "end in .stl"),
        ("   ", "must not be empty"),
    ],
)
async def test_export_stl_rejects_bad_paths(
    client: Client[Any], fake: FakeVibecad, path: str, message: str
) -> None:
    text = await call_error(client, "export_stl", {"script": SCRIPT, "path": path})
    assert message in text
    assert fake.requests == []


async def test_export_stl_rejects_symlink_escape(
    client: Client[Any],
    fake: FakeVibecad,
    settings: Settings,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    outside = tmp_path_factory.mktemp("outside")
    (settings.output_dir / "link").symlink_to(outside, target_is_directory=True)
    text = await call_error(client, "export_stl", {"script": SCRIPT, "path": "link/x.stl"})
    assert "inside the output directory" in text
    assert list(outside.iterdir()) == []


async def test_export_stl_resolves_a_symlinked_output_dir(fake: FakeVibecad, tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "alias").symlink_to(real, target_is_directory=True)
    settings = Settings(url="http://vibecad.test", output_dir=tmp_path / "alias")
    async with Client(create_server(settings, fake.transport())) as client:
        await client.call_tool("export_stl", {"script": SCRIPT, "path": "part.stl"})
    assert (real / "part.stl").read_bytes() == b"solid-bytes"


async def test_export_stl_rejects_directory_target(
    client: Client[Any], fake: FakeVibecad, settings: Settings
) -> None:
    (settings.output_dir / "folder.stl").mkdir()
    text = await call_error(
        client, "export_stl", {"script": SCRIPT, "path": "folder.stl", "overwrite": True}
    )
    assert "is a directory" in text
    assert fake.requests == []


async def test_export_stl_writes_nothing_when_vibecad_fails(
    client: Client[Any], fake: FakeVibecad, settings: Settings
) -> None:
    fake.handler = vibecad_error(422, "limit_exceeded", "mesh has too many triangles")
    text = await call_error(client, "export_stl", {"script": SCRIPT, "path": "big.stl"})
    assert text.startswith("limit_exceeded: mesh has too many triangles")
    assert not (settings.output_dir / "big.stl").exists()


# --- error handling shared by every tool ------------------------------------


@pytest.mark.parametrize(
    ("tool", "arguments"),
    [
        ("validate_script", {}),
        ("evaluate", {"points": [[0, 0, 0]]}),
        ("render_2d", {}),
        ("render_3d", {}),
        ("export_stl", {"path": "x.stl"}),
    ],
)
async def test_every_tool_reports_unreachable_server(
    settings: Settings, tool: str, arguments: dict[str, Any]
) -> None:
    def refuse(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("Connection refused", request=request)

    async with Client(create_server(settings, httpx2.MockTransport(refuse))) as client:
        text = await call_error(client, tool, {"script": SCRIPT, **arguments})
    assert "could not reach vibecad at http://vibecad.test" in text


async def test_unexpected_exceptions_are_masked(settings: Settings) -> None:
    def explode(request: httpx2.Request) -> httpx2.Response:
        raise RuntimeError("internal secret detail")

    async with Client(create_server(settings, httpx2.MockTransport(explode))) as client:
        text = await call_error(client, "validate_script", {"script": SCRIPT})
    assert "internal secret detail" not in text


async def test_http_client_is_closed_when_session_ends(
    server: FastMCP, monkeypatch: pytest.MonkeyPatch
) -> None:
    closed: list[bool] = []
    original = httpx2.AsyncClient.aclose

    async def tracking_aclose(self: httpx2.AsyncClient) -> None:
        closed.append(True)
        await original(self)

    monkeypatch.setattr(httpx2.AsyncClient, "aclose", tracking_aclose)
    async with Client(server) as client:
        await client.call_tool("validate_script", {"script": SCRIPT})
        assert closed == []
    assert closed == [True]


async def test_server_can_serve_several_sessions(server: FastMCP) -> None:
    for _ in range(2):
        async with Client(server) as client:
            result = await client.call_tool("validate_script", {"script": SCRIPT})
            assert result.data["nodes"] == 9


# --- entry points -----------------------------------------------------------


def test_main_runs_stdio_by_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    built: list[Settings] = []
    runs: list[dict[str, Any]] = []

    def fake_create_server(settings: Settings) -> FastMCP:
        built.append(settings)
        return create_server(settings)

    monkeypatch.setattr(server_module, "create_server", fake_create_server)
    monkeypatch.setattr(FastMCP, "run", lambda self, **kwargs: runs.append(kwargs))
    monkeypatch.setenv("VIBECAD_URL", "http://example.test:1234")
    monkeypatch.setenv("VIBECAD_MCP_OUTPUT_DIR", str(tmp_path))
    server_module.main()
    [settings] = built
    assert settings.url == "http://example.test:1234"
    assert settings.output_dir == tmp_path.resolve()
    assert runs == [{"show_banner": False}]


def test_main_runs_http_with_host_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    runs: list[dict[str, Any]] = []
    monkeypatch.setattr(FastMCP, "run", lambda self, **kwargs: runs.append(kwargs))
    monkeypatch.setenv("VIBECAD_MCP_TRANSPORT", "http")
    monkeypatch.setenv("VIBECAD_MCP_HOST", "0.0.0.0")
    monkeypatch.setenv("VIBECAD_MCP_PORT", "9123")
    monkeypatch.setenv("VIBECAD_MCP_ALLOWED_HOSTS", "localhost,mcp")
    server_module.main()
    assert runs == [
        {
            "transport": "http",
            "host": "0.0.0.0",
            "port": 9123,
            "host_origin_protection": True,
            "allowed_hosts": ["localhost", "mcp"],
            "show_banner": False,
        }
    ]


async def test_healthz_route(server: FastMCP) -> None:
    app = server.http_app()
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://localhost") as http:
        response = await http.get("/healthz")
    assert response.status_code == 200
    assert response.text == "ok"


def test_main_exits_cleanly_on_bad_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(FastMCP, "run", lambda self, *args, **kwargs: pytest.fail("ran"))
    monkeypatch.setenv("VIBECAD_URL", "localhost:8080")
    with pytest.raises(SystemExit) as caught:
        server_module.main()
    assert str(caught.value).startswith("vibecad-mcp: VIBECAD_URL must start with http://")


def test_python_dash_m_calls_main(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[bool] = []
    monkeypatch.setattr(server_module, "main", lambda: calls.append(True))
    runpy.run_module("vibecad_mcp", run_name="__main__")
    assert calls == [True]
