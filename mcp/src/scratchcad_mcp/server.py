"""MCP server exposing the scratchcad API as five tools."""

import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx2
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.lifespan import lifespan
from fastmcp.utilities.types import Image
from pydantic import BaseModel, Field
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from .client import ScratchcadClient, ScratchcadError
from .config import ConfigError, Settings

GUIDE = """\
scratchcad models solids as implicit surfaces written in Rhai scripts. The field \
is negative inside the shape, zero on the surface and positive outside.

A script produces its shape in one of two ways:
- it calls draw(shape) exactly once, or
- its last expression is a shape.

Math: the variables x, y and z, arithmetic, min, max, abs, sqrt, square, sin, \
cos, tan, asin, acos, atan, exp, ln, floor, ceil, round, remap. For example \
`sqrt(x*x + y*y + z*z) - 1` is a unit sphere. min(a, b) is a union and \
max(a, b) is an intersection.

Shapes take a map of named fields (points are [x, y, z] arrays and angles are \
in degrees):
- sphere(#{ radius: 1.0, center: [0, 0, 0] })
- box(#{ lower: [-1, -1, -1], upper: [1, 1, 1] })
- circle(#{ radius: 1.0, center: [0, 0] }) and rectangle(#{ lower: [x, y], \
upper: [x, y] }) are 2D, so they extend forever along z. Use extrude_z to cap them.
- union([a, b, ...]), intersection([a, b, ...])
- difference(#{ shape: a, cutout: b }), inverse(#{ shape: a })
- blend(#{ a: a, b: b, radius: 0.1 }) is a smooth union
- move(#{ shape: a, offset: [dx, dy, dz] }), scale(#{ shape: a, scale: [sx, sy, sz] }), \
scale_uniform(#{ shape: a, scale: 2.0 })
- rotate_x / rotate_y / rotate_z(#{ shape: a, angle: 90.0, center: [0, 0, 0] })
- extrude_z(#{ shape: profile2d, lower: -1, upper: 1 }), loft_z(#{ a: p, b: q, lower, upper })
- revolve_y(#{ shape: profile2d, offset: 0.0 }), repeat_x(#{ shape: a, radius, offset })
- reflect_x / reflect_y / reflect_z(#{ shape: a, offset: 0.0 })
Fields with defaults (center, offset) can be left out. Shapes also work as \
methods: sphere(#{ radius: 1.0 }).move([1, 0, 0]).

Units are whatever you choose. Most slicers read STL files as millimetres. \
Every render and the STL export only cover the cube center ± half_size \
(default ±1), so set center and half_size to enclose the whole part, or it \
will be clipped. render_3d rotates that cube, so its half_size must also \
cover the part's corners: use at least the distance from center to the \
farthest point (about 1.75 times the half-width for a cube). A flat, brightly \
lit cut face that is not part of the design means the view is too small.

Workflow: validate_script first to catch errors cheaply, then render_3d to \
see the shape, render_2d for a cross-section at z = 0 (move or rotate the \
shape to slice elsewhere), evaluate to check exact dimensions (a point is \
inside when its value is negative), and export_stl once it looks right."""

Script = Annotated[
    str,
    Field(description="Rhai script that draws the shape. See the server instructions."),
]
Evaluator = Annotated[
    Literal["jit", "vm"] | None,
    Field(description="Evaluator backend. Leave unset for the server default (jit)."),
]
Vec3 = tuple[float, float, float]
Center3 = Annotated[Vec3, Field(description="Model-space point at the middle of the view.")]
HalfSize = Annotated[
    float,
    Field(gt=0, description="The region covered is center ± half_size on each axis."),
]
Pixels = Annotated[int, Field(ge=1, description="Image size in pixels.")]


class StlExport(BaseModel):
    path: str = Field(description="Absolute path of the written STL file.")
    bytes: int
    triangles: int | None
    compute_ms: float | None


def create_server(
    settings: Settings, transport: httpx2.AsyncBaseTransport | None = None
) -> FastMCP:
    """Build the server. `transport` lets tests replace the network."""

    @lifespan
    async def scratchcad_client(server: FastMCP) -> Any:
        api = ScratchcadClient(settings, transport)
        try:
            yield {"api": api}
        finally:
            await api.aclose()

    mcp = FastMCP(
        "scratchcad", instructions=GUIDE, lifespan=scratchcad_client, mask_error_details=True
    )
    read_only = {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False}

    async def call[T](
        ctx: Context,
        request: Callable[[ScratchcadClient, dict[str, Any]], Awaitable[T]],
        body: dict[str, Any],
    ) -> T:
        api: ScratchcadClient = ctx.lifespan_context["api"]
        try:
            return await request(api, _drop_none(body))
        except ScratchcadError as exc:
            raise ToolError(str(exc)) from None

    @mcp.tool(annotations=read_only)
    async def validate_script(script: Script, ctx: Context) -> dict[str, Any]:
        """Check a script without rendering it.

        Returns the node count of the resulting math graph, anything the script
        printed and the compile time. Errors include the line and column.
        """
        return await call(ctx, ScratchcadClient.validate, {"script": script})

    @mcp.tool(annotations=read_only)
    async def evaluate(
        script: Script,
        ctx: Context,
        mode: Annotated[
            Literal["value", "gradient", "interval"],
            Field(description="value and gradient use points; interval uses intervals."),
        ] = "value",
        points: Annotated[
            list[Vec3] | None,
            Field(description="Points [x, y, z] to sample, for value and gradient modes."),
        ] = None,
        intervals: Annotated[
            list[tuple[tuple[float, float], tuple[float, float], tuple[float, float]]] | None,
            Field(
                description="Boxes [[xmin, xmax], [ymin, ymax], [zmin, zmax]], for interval mode."
            ),
        ] = None,
        evaluator: Evaluator = None,
    ) -> dict[str, Any]:
        """Sample the field exactly, to measure the shape rather than eyeball it.

        A negative value means the point is inside. gradient mode also returns
        the surface normal direction. interval mode returns conservative
        [lower, upper] bounds over each box: an upper bound below zero means the
        box is entirely solid, and a lower bound above zero means it is empty.
        """
        return await call(
            ctx,
            ScratchcadClient.eval,
            {
                "script": script,
                "mode": mode,
                "points": points,
                "intervals": intervals,
                "evaluator": evaluator,
            },
        )

    @mcp.tool(annotations=read_only)
    async def render_2d(
        script: Script,
        ctx: Context,
        width: Pixels = 512,
        height: Pixels = 512,
        mode: Annotated[
            Literal["mono", "sdf", "debug"],
            Field(
                description="mono is white on black, sdf colours by distance, "
                "debug shows interval levels."
            ),
        ] = "mono",
        center: Annotated[
            tuple[float, float], Field(description="Model-space point at the image center.")
        ] = (0.0, 0.0),
        half_size: HalfSize = 1.0,
        evaluator: Evaluator = None,
    ) -> Image:
        """Render the cross-section at z = 0 as a PNG.

        Use it to see inside a part: holes, wall thickness and internal
        features. To slice at another height, move the shape in the script.
        """
        result = await call(
            ctx,
            ScratchcadClient.raster_2d,
            {
                "script": script,
                "width": width,
                "height": height,
                "mode": mode,
                "center": list(center),
                "half_size": half_size,
                "evaluator": evaluator,
            },
        )
        return Image(data=result.data, format="png")

    @mcp.tool(annotations=read_only)
    async def render_3d(
        script: Script,
        ctx: Context,
        width: Pixels = 512,
        height: Pixels = 512,
        yaw: Annotated[float, Field(description="Degrees about the Y axis.")] = 30.0,
        pitch: Annotated[float, Field(description="Degrees about the X axis.")] = -20.0,
        roll: Annotated[float, Field(description="Degrees about the Z axis.")] = 0.0,
        center: Center3 = (0.0, 0.0, 0.0),
        half_size: HalfSize = 1.0,
        mode: Annotated[
            Literal["shaded", "normals", "heightmap"], Field(description="Shading style.")
        ] = "shaded",
        ssao: Annotated[bool, Field(description="Ambient occlusion (shaded mode only).")] = True,
        perspective: Annotated[
            float, Field(ge=0, le=1, description="0 is orthographic, up to 1.")
        ] = 0.0,
        depth: Annotated[
            int | None,
            Field(ge=1, description="Voxels along the view axis. Defaults to max(width, height)."),
        ] = None,
        evaluator: Evaluator = None,
    ) -> Image:
        """Render a shaded 3D view of the shape as a PNG with a transparent background.

        With no rotation the camera looks along -z with +y up. The default
        angle turns the part slightly so three faces show. Render several
        angles to check a part from all sides.
        """
        result = await call(
            ctx,
            ScratchcadClient.raster_3d,
            {
                "script": script,
                "width": width,
                "height": height,
                "depth": depth,
                "mode": mode,
                "ssao": ssao if mode == "shaded" else None,
                "center": list(center),
                "half_size": half_size,
                "rotation": {"yaw": yaw, "pitch": pitch, "roll": roll},
                "perspective": perspective,
                "evaluator": evaluator,
            },
        )
        return Image(data=result.data, format="png")

    @mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True})
    async def export_stl(
        script: Script,
        path: Annotated[
            str,
            Field(
                description="Where to write the .stl file, relative to the output "
                "directory (SCRATCHCAD_MCP_OUTPUT_DIR). It cannot leave that directory."
            ),
        ],
        ctx: Context,
        center: Center3 = (0.0, 0.0, 0.0),
        half_size: HalfSize = 1.0,
        depth: Annotated[
            int,
            Field(ge=1, description="Octree depth; the mesh has 2^depth cells per axis."),
        ] = 6,
        overwrite: Annotated[
            bool, Field(description="Replace the file if it already exists.")
        ] = False,
        evaluator: Evaluator = None,
    ) -> StlExport:
        """Mesh the shape and save it as a binary STL file.

        Vertices are in model coordinates. Only the cube center ± half_size is
        meshed, so make it enclose the whole part.
        """
        target = _resolve_output(settings.output_dir, path, overwrite)
        result = await call(
            ctx,
            ScratchcadClient.export_stl,
            {
                "script": script,
                "center": list(center),
                "half_size": half_size,
                "depth": depth,
                "evaluator": evaluator,
            },
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result.data)
        return StlExport(
            path=str(target),
            bytes=len(result.data),
            triangles=result.triangles,
            compute_ms=result.compute_ms,
        )

    @mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
    async def healthz(request: Request) -> PlainTextResponse:
        """Liveness probe for HTTP mode (used by the dev container)."""
        return PlainTextResponse("ok")

    return mcp


def _drop_none(body: dict[str, Any]) -> dict[str, Any]:
    """Leave unset options out of the request so the server applies its defaults."""
    return {key: value for key, value in body.items() if value is not None}


def _resolve_output(output_dir: Path, path: str, overwrite: bool) -> Path:
    if not path.strip():
        raise ToolError("path must not be empty")
    output_dir = output_dir.resolve()
    target = (output_dir / path).resolve()
    if not target.is_relative_to(output_dir):
        raise ToolError(f"path must stay inside the output directory {output_dir}")
    if target.suffix.lower() != ".stl":
        raise ToolError("path must end in .stl")
    if target.is_dir():
        raise ToolError(f"{target} is a directory")
    if target.exists() and not overwrite:
        raise ToolError(f"{target} already exists; pass overwrite=true to replace it")
    return target


def main() -> None:
    try:
        settings = Settings.from_env()
    except ConfigError as exc:
        sys.exit(f"scratchcad-mcp: {exc}")
    server = create_server(settings)
    # The banner would only clutter MCP client logs.
    if settings.transport == "stdio":
        server.run(show_banner=False)
    else:
        server.run(
            transport="http",
            host=settings.host,
            port=settings.port,
            # FastMCP leaves this off by default for non-loopback binds, and
            # the container must bind 0.0.0.0, so turn it on explicitly.
            host_origin_protection=True,
            allowed_hosts=list(settings.allowed_hosts),
            show_banner=False,
        )
