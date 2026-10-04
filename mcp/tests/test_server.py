"""The MCP surface, exercised through a real MCP client session in memory."""

import base64
import os
import runpy
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastmcp import Client, FastMCP
from mcp_types import ImageContent, TextContent

from scratchcad_mcp import server as server_module
from scratchcad_mcp.config import Settings
from scratchcad_mcp.server import GUIDE, create_server

from .conftest import PNG, TOOLS, FakeScratchcad, scratchcad_error

SCRIPT = "draw(sphere(#{ radius: 0.5 }))"
WRITING = {"export_stl", "save_script"}


async def call_error(client: Client[Any], tool: str, arguments: dict[str, Any]) -> str:
    """Call a tool that is expected to fail and return the error text the model sees."""
    result = await client.call_tool(tool, arguments, raise_on_error=False)
    assert result.is_error
    [content] = result.content
    assert isinstance(content, TextContent)
    return content.text


# --- discovery -------------------------------------------------------------


async def test_lists_exactly_the_tools(client: Client[Any]) -> None:
    assert {tool.name for tool in await client.list_tools()} == TOOLS


async def test_instructions_carry_the_scripting_guide(client: Client[Any]) -> None:
    assert client.instructions == GUIDE
    for needle in (
        "draw(shape)",
        "difference(",
        "degrees",
        "half_size",
        "negative",
        "finite",
        "save_script",
        "read_script",
        "call export_stl when the user asks",
        "// [10, 60]",
    ):
        assert needle in GUIDE


async def test_every_tool_documents_every_parameter(client: Client[Any]) -> None:
    for tool in await client.list_tools():
        assert tool.description, tool.name
        properties = tool.input_schema["properties"]
        assert "ctx" not in properties
        required = "path" if tool.name == "read_script" else "script"
        assert required in tool.input_schema["required"]
        for name, schema in properties.items():
            assert schema.get("description"), f"{tool.name}.{name} has no description"


async def test_annotations_mark_only_export_and_save_as_writing(client: Client[Any]) -> None:
    tools = {tool.name: tool for tool in await client.list_tools()}
    for name in TOOLS - WRITING:
        annotations = tools[name].annotations
        assert annotations is not None
        assert annotations.read_only_hint is True
        assert annotations.idempotent_hint is True
    for name in WRITING:
        annotations = tools[name].annotations
        assert annotations is not None
        assert annotations.read_only_hint is False
        assert annotations.destructive_hint is True


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


async def test_validate_script(client: Client[Any], fake: FakeScratchcad) -> None:
    result = await client.call_tool("validate_script", {"script": SCRIPT})
    assert result.data == {"nodes": 9, "output": ["hi"], "compile_ms": 0.8}
    assert fake.last.url.path == "/v1/scripts/validate"
    assert fake.last_body == {"script": SCRIPT}


async def test_script_errors_reach_the_model_verbatim(
    client: Client[Any], fake: FakeScratchcad
) -> None:
    fake.handler = scratchcad_error(
        422, "script_error", "script error: Script is incomplete (line 1, position 12)"
    )
    text = await call_error(client, "validate_script", {"script": "let q = 1 +"})
    assert text == "script_error: script error: Script is incomplete (line 1, position 12)"


# --- evaluate ---------------------------------------------------------------


async def test_evaluate_defaults_to_value_mode(client: Client[Any], fake: FakeScratchcad) -> None:
    result = await client.call_tool("evaluate", {"script": SCRIPT, "points": [[0, 0, 0]]})
    assert result.data == {"values": [-1.0], "compute_ms": 0.02}
    assert fake.last.url.path == "/v1/eval"
    assert fake.last_body == {"script": SCRIPT, "mode": "value", "points": [[0.0, 0.0, 0.0]]}


async def test_evaluate_gradient_and_evaluator(client: Client[Any], fake: FakeScratchcad) -> None:
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


async def test_evaluate_interval_mode(client: Client[Any], fake: FakeScratchcad) -> None:
    box = [[-1, 1], [-1, 1], [-1, 1]]
    await client.call_tool("evaluate", {"script": SCRIPT, "mode": "interval", "intervals": [box]})
    assert fake.last_body == {
        "script": SCRIPT,
        "mode": "interval",
        "intervals": [[[-1.0, 1.0], [-1.0, 1.0], [-1.0, 1.0]]],
    }


async def test_evaluate_rejects_malformed_points(client: Client[Any], fake: FakeScratchcad) -> None:
    text = await call_error(client, "evaluate", {"script": SCRIPT, "points": [[1, 2]]})
    assert "points" in text
    assert fake.requests == []


# --- render_2d --------------------------------------------------------------


async def test_render_2d_returns_png(client: Client[Any], fake: FakeScratchcad) -> None:
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


async def test_render_2d_passes_every_option(client: Client[Any], fake: FakeScratchcad) -> None:
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


@pytest.mark.parametrize("tool", ["render_2d", "render_3d"])
async def test_render_warnings_follow_the_image(
    client: Client[Any], fake: FakeScratchcad, tool: str
) -> None:
    fake.handler = lambda request: httpx2.Response(
        200,
        content=PNG,
        headers={"content-type": "image/png", "x-warning": "the field is NaN at (0, 0, 0)"},
    )
    result = await client.call_tool(tool, {"script": SCRIPT})
    image, warning = result.content
    assert isinstance(image, ImageContent)
    assert base64.b64decode(image.data) == PNG
    assert isinstance(warning, TextContent)
    assert warning.text == "Warning: the field is NaN at (0, 0, 0)"


# --- render_3d --------------------------------------------------------------


async def test_render_3d_returns_png_with_a_three_quarter_view(
    client: Client[Any], fake: FakeScratchcad
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


async def test_render_3d_passes_every_option(client: Client[Any], fake: FakeScratchcad) -> None:
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
    client: Client[Any], fake: FakeScratchcad, mode: str
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
    client: Client[Any], fake: FakeScratchcad, arguments: dict[str, Any]
) -> None:
    await call_error(client, "render_3d", {"script": SCRIPT, **arguments})
    assert fake.requests == []


async def test_missing_script_is_rejected(client: Client[Any], fake: FakeScratchcad) -> None:
    text = await call_error(client, "render_3d", {})
    assert "script" in text
    assert fake.requests == []


# --- export_stl -------------------------------------------------------------


async def test_export_stl_writes_the_file(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    result = await client.call_tool("export_stl", {"script": SCRIPT, "path": "part.stl"})
    target = settings.output_dir / "part.stl"
    assert result.structured_content == {
        "path": str(target),
        "bytes": len(b"solid-bytes"),
        "triangles": 1234,
        "compute_ms": 40.25,
        "warnings": [],
    }
    assert target.read_bytes() == b"solid-bytes"
    assert fake.last.url.path == "/v1/export/stl"
    assert fake.last_body == {
        "script": SCRIPT,
        "center": [0.0, 0.0, 0.0],
        "half_size": 1.0,
        "depth": 6,
    }


async def test_export_stl_reports_warnings(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    fake.handler = lambda request: httpx2.Response(
        200,
        content=b"solid-bytes",
        headers={
            "x-triangle-count": "8",
            "x-warning": "the shape reaches the boundary on its -x, +x side(s)",
        },
    )
    result = await client.call_tool("export_stl", {"script": SCRIPT, "path": "part.stl"})
    assert result.structured_content is not None
    assert result.structured_content["warnings"] == [
        "the shape reaches the boundary on its -x, +x side(s)"
    ]
    assert (settings.output_dir / "part.stl").read_bytes() == b"solid-bytes"


async def test_export_stl_passes_every_option(client: Client[Any], fake: FakeScratchcad) -> None:
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
    client: Client[Any], fake: FakeScratchcad, settings: Settings
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
    client: Client[Any], fake: FakeScratchcad, path: str, message: str
) -> None:
    text = await call_error(client, "export_stl", {"script": SCRIPT, "path": path})
    assert message in text
    assert fake.requests == []


async def test_export_stl_rejects_symlink_escape(
    client: Client[Any],
    fake: FakeScratchcad,
    settings: Settings,
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    outside = tmp_path_factory.mktemp("outside")
    (settings.output_dir / "link").symlink_to(outside, target_is_directory=True)
    text = await call_error(client, "export_stl", {"script": SCRIPT, "path": "link/x.stl"})
    assert "inside the output directory" in text
    assert list(outside.iterdir()) == []


async def test_export_stl_resolves_a_symlinked_output_dir(
    fake: FakeScratchcad, tmp_path: Path
) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (tmp_path / "alias").symlink_to(real, target_is_directory=True)
    settings = Settings(url="http://scratchcad.test", output_dir=tmp_path / "alias")
    async with Client(create_server(settings, fake.transport())) as client:
        await client.call_tool("export_stl", {"script": SCRIPT, "path": "part.stl"})
    assert (real / "part.stl").read_bytes() == b"solid-bytes"


async def test_export_stl_rejects_directory_target(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    (settings.output_dir / "folder.stl").mkdir()
    text = await call_error(
        client, "export_stl", {"script": SCRIPT, "path": "folder.stl", "overwrite": True}
    )
    assert "is a directory" in text
    assert fake.requests == []


async def test_export_stl_writes_nothing_when_scratchcad_fails(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    fake.handler = scratchcad_error(422, "limit_exceeded", "mesh has too many triangles")
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
    assert "could not reach scratchcad at http://scratchcad.test" in text


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
    monkeypatch.setenv("SCRATCHCAD_URL", "http://example.test:1234")
    monkeypatch.setenv("SCRATCHCAD_MCP_OUTPUT_DIR", str(tmp_path))
    server_module.main()
    [settings] = built
    assert settings.url == "http://example.test:1234"
    assert settings.output_dir == tmp_path.resolve()
    assert runs == [{"show_banner": False}]


def test_main_runs_http_with_host_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    runs: list[dict[str, Any]] = []
    monkeypatch.setattr(FastMCP, "run", lambda self, **kwargs: runs.append(kwargs))
    monkeypatch.setenv("SCRATCHCAD_MCP_TRANSPORT", "http")
    monkeypatch.setenv("SCRATCHCAD_MCP_HOST", "0.0.0.0")
    monkeypatch.setenv("SCRATCHCAD_MCP_PORT", "9123")
    monkeypatch.setenv("SCRATCHCAD_MCP_ALLOWED_HOSTS", "localhost,mcp")
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


# --- save_script / read_script ------------------------------------------------


async def test_save_script_validates_and_writes_with_a_region_line(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    result = await client.call_tool(
        "save_script",
        {"script": SCRIPT, "path": "parts/ball.rhai", "center": [1, 2, 3], "half_size": 2.5},
    )
    target = settings.output_dir / "parts" / "ball.rhai"
    text = f"// region: center=[1, 2, 3] half_size=2.5\n{SCRIPT}\n"
    assert target.read_text() == text
    assert result.structured_content == {
        "path": str(target),
        "bytes": len(text),
        "nodes": 9,
        "center": [1.0, 2.0, 3.0],
        "half_size": 2.5,
    }
    assert fake.last.url.path == "/v1/scripts/validate"
    assert fake.last_body == {"script": SCRIPT}


async def test_save_script_keeps_or_replaces_an_existing_region_line(
    client: Client[Any], settings: Settings
) -> None:
    script = f"// region: center=[0, 0, 5] half_size=12\n{SCRIPT}"
    await client.call_tool("save_script", {"script": script, "path": "a.rhai"})
    assert (settings.output_dir / "a.rhai").read_text() == f"{script}\n"
    await client.call_tool("save_script", {"script": script, "path": "b.rhai", "half_size": 20})
    assert (
        (settings.output_dir / "b.rhai")
        .read_text()
        .startswith("// region: center=[0, 0, 5] half_size=20\n")
    )


async def test_save_script_defaults_to_the_unit_region(
    client: Client[Any], settings: Settings
) -> None:
    await client.call_tool("save_script", {"script": SCRIPT, "path": "a.rhai"})
    assert (settings.output_dir / "a.rhai").read_text() == (
        f"// region: center=[0, 0, 0] half_size=1\n{SCRIPT}\n"
    )


async def test_save_script_writes_nothing_for_an_invalid_script(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    fake.handler = scratchcad_error(422, "script_error", "script error: oops (line 1, position 2)")
    text = await call_error(client, "save_script", {"script": "let", "path": "bad.rhai"})
    assert text == "script_error: script error: oops (line 1, position 2)"
    assert not (settings.output_dir / "bad.rhai").exists()


async def test_save_script_refuses_to_overwrite_by_default(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    target = settings.output_dir / "a.rhai"
    target.write_text("// mine\n")
    text = await call_error(client, "save_script", {"script": SCRIPT, "path": "a.rhai"})
    assert "already exists" in text
    assert fake.requests == []
    await client.call_tool("save_script", {"script": SCRIPT, "path": "a.rhai", "overwrite": True})
    assert SCRIPT in target.read_text()


@pytest.mark.parametrize(
    ("path", "message"),
    [("../a.rhai", "inside the output directory"), ("a.stl", "end in .rhai"), ("", "empty")],
)
async def test_save_script_rejects_bad_paths(
    client: Client[Any], fake: FakeScratchcad, path: str, message: str
) -> None:
    text = await call_error(client, "save_script", {"script": SCRIPT, "path": path})
    assert message in text
    assert fake.requests == []


async def test_read_script_returns_the_text_and_region(
    client: Client[Any], fake: FakeScratchcad, settings: Settings
) -> None:
    text = f"// region: center=[0, -1, 0] half_size=4\n{SCRIPT}\n"
    (settings.output_dir / "a.rhai").write_text(text)
    result = await client.call_tool("read_script", {"path": "a.rhai"})
    assert result.structured_content == {
        "path": str(settings.output_dir / "a.rhai"),
        "script": text,
        "center": [0.0, -1.0, 0.0],
        "half_size": 4.0,
    }
    assert fake.requests == []


async def test_read_script_without_a_region_line(client: Client[Any], settings: Settings) -> None:
    (settings.output_dir / "a.rhai").write_text(SCRIPT)
    result = await client.call_tool("read_script", {"path": "a.rhai"})
    assert result.structured_content is not None
    assert result.structured_content["center"] is None
    assert result.structured_content["half_size"] is None


async def test_read_script_errors(client: Client[Any], settings: Settings) -> None:
    (settings.output_dir / "binary.rhai").write_bytes(b"\xff\xfe")
    assert "not UTF-8" in await call_error(client, "read_script", {"path": "binary.rhai"})
    assert "does not exist" in await call_error(client, "read_script", {"path": "nope.rhai"})
    assert "end in .rhai" in await call_error(client, "read_script", {"path": "a.stl"})


# --- file API for the editor ------------------------------------------------


async def http(server: FastMCP, method: str, path: str, **kwargs: Any) -> httpx2.Response:
    transport = httpx2.ASGITransport(app=server.http_app())
    async with httpx2.AsyncClient(transport=transport, base_url="http://localhost") as client:
        return await client.request(method, path, **kwargs)


def write_file(path: Path, data: bytes, mtime: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    os.utime(path, (mtime, mtime))


async def test_files_lists_scripts_and_meshes_newest_first(
    server: FastMCP, settings: Settings
) -> None:
    out = settings.output_dir
    write_file(out / "old.stl", b"a", 1_000)
    write_file(out / "parts" / "new.RHAI", b"bbb", 3_000)
    write_file(out / "b.stl", b"cc", 2_000)
    write_file(out / "a.rhai", b"cc", 2_000)
    write_file(out / "notes.txt", b"not a part", 4_000)
    write_file(out / ".cache" / "hidden.stl", b"x", 5_000)
    (out / "folder.stl").mkdir()
    response = await http(server, "GET", "/files")
    assert response.status_code == 200
    files = response.json()
    assert [(f["path"], f["kind"], f["bytes"], f["modified"]) for f in files] == [
        ("parts/new.RHAI", "script", 3, 3_000),
        ("a.rhai", "script", 2, 2_000),
        ("b.stl", "mesh", 2, 2_000),
        ("old.stl", "mesh", 1, 1_000),
    ]
    assert all(f["version"] for f in files)


async def test_files_skips_symlinks_out_of_the_output_dir(
    server: FastMCP, settings: Settings, tmp_path_factory: pytest.TempPathFactory
) -> None:
    outside = tmp_path_factory.mktemp("outside") / "secret.rhai"
    outside.write_text("secret")
    (settings.output_dir / "link.rhai").symlink_to(outside)
    write_file(settings.output_dir / "real.stl", b"ok", 1_000)
    response = await http(server, "GET", "/files")
    assert [f["path"] for f in response.json()] == ["real.stl"]
    response = await http(server, "GET", "/files/link.rhai")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_path"


async def test_files_of_a_missing_output_dir_is_empty(fake: FakeScratchcad) -> None:
    settings = Settings(url="http://scratchcad.test", output_dir=Path("/nonexistent/scratchcad"))
    response = await http(create_server(settings, fake.transport()), "GET", "/files")
    assert response.status_code == 200
    assert response.json() == []


async def test_files_serves_scripts_and_meshes(server: FastMCP, settings: Settings) -> None:
    write_file(settings.output_dir / "parts" / "my bolt.stl", b"solid-bytes", 1_000)
    write_file(settings.output_dir / "bolt.rhai", SCRIPT.encode(), 1_000)
    mesh = await http(server, "GET", "/files/parts/my%20bolt.stl")
    assert mesh.status_code == 200
    assert mesh.content == b"solid-bytes"
    assert mesh.headers["content-type"] == "model/stl"
    assert mesh.headers["cache-control"] == "no-cache"
    script = await http(server, "GET", "/files/bolt.rhai")
    assert script.text == SCRIPT
    assert script.headers["content-type"] == "text/plain; charset=utf-8"
    listed = (await http(server, "GET", "/files")).json()
    assert script.headers["x-version"] == next(
        f["version"] for f in listed if f["kind"] == "script"
    )


@pytest.mark.parametrize(
    ("path", "status"),
    [
        ("missing.stl", 404),
        ("notes.txt", 400),
        ("folder.stl", 400),
        ("..%2Fescape.stl", 400),
        ("%2Fetc%2Fpasswd", 400),
    ],
)
async def test_files_refuses_anything_but_parts_inside_the_output_dir(
    server: FastMCP, settings: Settings, path: str, status: int
) -> None:
    write_file(settings.output_dir / "notes.txt", b"text", 1_000)
    write_file(settings.output_dir.parent / "escape.stl", b"outside", 1_000)
    (settings.output_dir / "folder.stl").mkdir()
    response = await http(server, "GET", f"/files/{path}")
    assert response.status_code == status
    assert response.json()["error"]["message"]


async def test_put_creates_and_replaces_files(server: FastMCP, settings: Settings) -> None:
    created = await http(server, "PUT", "/files/new/part.rhai", content=SCRIPT.encode())
    assert created.status_code == 200
    body = created.json()
    assert body["path"] == "new/part.rhai"
    assert body["kind"] == "script"
    assert body["bytes"] == len(SCRIPT)
    assert (settings.output_dir / "new" / "part.rhai").read_text() == SCRIPT
    mesh = await http(server, "PUT", "/files/part.stl", content=b"solid")
    assert mesh.json()["kind"] == "mesh"
    assert (settings.output_dir / "part.stl").read_bytes() == b"solid"
    assert sorted(p.name for p in settings.output_dir.iterdir()) == ["new", "part.stl"]


async def test_put_checks_the_expected_version(server: FastMCP, settings: Settings) -> None:
    first = (await http(server, "PUT", "/files/a.rhai", content=b"one")).json()
    os.utime(settings.output_dir / "a.rhai", (1_000, 1_000))
    stale = await http(
        server, "PUT", "/files/a.rhai", content=b"two",
        headers={"x-expected-version": first["version"]},
    )  # fmt: skip
    assert stale.status_code == 409
    error = stale.json()["error"]
    assert error["code"] == "conflict"
    assert "changed since it was read" in error["message"]
    current = error["current"]
    assert (settings.output_dir / "a.rhai").read_text() == "one"

    ok = await http(
        server, "PUT", "/files/a.rhai", content=b"two", headers={"x-expected-version": current}
    )
    assert ok.status_code == 200
    assert (settings.output_dir / "a.rhai").read_text() == "two"

    exists = await http(
        server, "PUT", "/files/a.rhai", content=b"three", headers={"x-expected-version": "new"}
    )
    assert exists.status_code == 409
    deleted = await http(
        server, "PUT", "/files/gone.rhai", content=b"x", headers={"x-expected-version": current}
    )
    assert deleted.status_code == 409
    assert "was deleted" in deleted.json()["error"]["message"]
    assert deleted.json()["error"]["current"] is None
    created = await http(
        server, "PUT", "/files/gone.rhai", content=b"x", headers={"x-expected-version": "new"}
    )
    assert created.status_code == 200


async def test_put_rejects_bad_uploads(
    server: FastMCP, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    bad_path = await http(server, "PUT", "/files/..%2Fx.rhai", content=b"x")
    assert bad_path.status_code == 400
    wrong_kind = await http(server, "PUT", "/files/x.txt", content=b"x")
    assert wrong_kind.json()["error"]["code"] == "invalid_path"
    not_text = await http(server, "PUT", "/files/x.rhai", content=b"\xff")
    assert not_text.json()["error"]["code"] == "not_utf8"

    monkeypatch.setattr(server_module, "MAX_SCRIPT_BYTES", 4)
    too_big = await http(server, "PUT", "/files/x.rhai", content=b"12345")
    assert too_big.status_code == 413
    assert too_big.json()["error"]["code"] == "too_large"

    async def chunks() -> Any:
        yield b"123"
        yield b"45"

    streamed = await http(server, "PUT", "/files/x.rhai", content=chunks())
    assert streamed.status_code == 413
    assert list(settings.output_dir.iterdir()) == []


def test_main_exits_cleanly_on_bad_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(FastMCP, "run", lambda self, *args, **kwargs: pytest.fail("ran"))
    monkeypatch.setenv("SCRATCHCAD_URL", "localhost:8080")
    with pytest.raises(SystemExit) as caught:
        server_module.main()
    assert str(caught.value).startswith("scratchcad-mcp: SCRATCHCAD_URL must start with http://")


def test_python_dash_m_calls_main(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[bool] = []
    monkeypatch.setattr(server_module, "main", lambda: calls.append(True))
    runpy.run_module("scratchcad_mcp", run_name="__main__")
    assert calls == [True]
