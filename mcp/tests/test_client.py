"""The HTTP client: request shape, response parsing and error translation."""

import re
from collections.abc import AsyncIterator

import httpx2
import pytest

from vibecad_mcp.client import VibecadClient, VibecadError
from vibecad_mcp.config import Settings

from .conftest import PNG, FakeVibecad, vibecad_error


@pytest.fixture
async def api(settings: Settings, fake: FakeVibecad) -> AsyncIterator[VibecadClient]:
    api = VibecadClient(settings, fake.transport())
    yield api
    await api.aclose()


async def test_posts_json_to_the_configured_server(api: VibecadClient, fake: FakeVibecad) -> None:
    assert await api.validate({"script": "x"}) == {
        "nodes": 9,
        "output": ["hi"],
        "compile_ms": 0.8,
    }
    request = fake.last
    assert request.method == "POST"
    assert str(request.url) == "http://vibecad.test/v1/scripts/validate"
    assert request.headers["content-type"] == "application/json"
    assert request.headers["user-agent"] == "vibecad-mcp"
    assert "authorization" not in request.headers
    assert fake.last_body == {"script": "x"}


async def test_sends_bearer_token_when_configured(fake: FakeVibecad) -> None:
    api = VibecadClient(Settings(url="http://vibecad.test", api_token="s3cret"), fake.transport())
    await api.validate({"script": "x"})
    await api.aclose()
    assert fake.last.headers["authorization"] == "Bearer s3cret"


async def test_every_endpoint_hits_its_route(api: VibecadClient, fake: FakeVibecad) -> None:
    assert (await api.eval({"script": "x"}))["values"] == [-1.0]
    await api.raster_2d({"script": "x"})
    await api.raster_3d({"script": "x"})
    await api.export_stl({"script": "x"})
    assert [r.url.path for r in fake.requests] == [
        "/v1/eval",
        "/v1/raster/2d",
        "/v1/raster/3d",
        "/v1/export/stl",
    ]


async def test_binary_responses_carry_header_metadata(api: VibecadClient) -> None:
    png = await api.raster_3d({"script": "x"})
    assert png.data == PNG
    assert png.compute_ms == 12.5
    assert png.triangles is None

    stl = await api.export_stl({"script": "x"})
    assert stl.data == b"solid-bytes"
    assert stl.compute_ms == 40.25
    assert stl.triangles == 1234


async def test_missing_or_garbled_headers_become_none(api: VibecadClient, fake: FakeVibecad) -> None:
    fake.handler = lambda request: httpx2.Response(
        200, content=b"stl", headers={"x-compute-ms": "fast", "x-triangle-count": "1.5"}
    )
    stl = await api.export_stl({"script": "x"})
    assert (stl.compute_ms, stl.triangles) == (None, None)


@pytest.mark.parametrize(
    ("status", "code", "hint"),
    [
        (422, "script_error", None),
        (400, "bad_request", None),
        (401, "unauthorized", "set VIBECAD_API_TOKEN"),
        (503, "overloaded", "retry in a moment"),
        (422, "limit_exceeded", "reduce the size"),
        (504, "timeout", None),
    ],
)
async def test_api_errors_keep_code_and_message(
    api: VibecadClient, fake: FakeVibecad, status: int, code: str, hint: str | None
) -> None:
    fake.handler = vibecad_error(status, code, "details (line 3, position 7)")
    with pytest.raises(VibecadError) as caught:
        await api.validate({"script": "x"})
    error = caught.value
    assert str(error).startswith(f"{code}: details (line 3, position 7)")
    assert (error.code, error.status) == (code, status)
    if hint is None:
        assert "(" not in str(error).removeprefix(f"{code}: details (line 3, position 7)")
    else:
        assert hint in str(error)


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            httpx2.Response(502, text="<html>Bad Gateway</html>"),
            "HTTP 502: <html>Bad Gateway</html>",
        ),
        (httpx2.Response(500, json={"message": "no error key"}), 'HTTP 500: {"message"'),
        (httpx2.Response(500, json={"error": "flat string"}), "HTTP 500: "),
        (httpx2.Response(503), "HTTP 503: Service Unavailable"),
    ],
)
async def test_non_vibecad_errors_report_status_and_body(
    api: VibecadClient, fake: FakeVibecad, response: httpx2.Response, expected: str
) -> None:
    fake.handler = lambda request: response
    with pytest.raises(VibecadError, match="^vibecad returned " + re.escape(expected)) as caught:
        await api.eval({"script": "x"})
    assert caught.value.code is None
    assert caught.value.status == response.status_code


async def test_long_error_bodies_are_truncated(api: VibecadClient, fake: FakeVibecad) -> None:
    fake.handler = lambda request: httpx2.Response(500, text="x" * 5000)
    with pytest.raises(VibecadError) as caught:
        await api.eval({"script": "x"})
    assert len(str(caught.value)) < 600


async def test_connection_failure_names_the_url(settings: Settings) -> None:
    def refuse(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("Connection refused", request=request)

    api = VibecadClient(settings, httpx2.MockTransport(refuse))
    with pytest.raises(
        VibecadError, match=r"could not reach vibecad at http://vibecad\.test.*running"
    ):
        await api.validate({"script": "x"})
    await api.aclose()


async def test_timeout_reports_the_budget() -> None:
    def hang(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("timed out", request=request)

    api = VibecadClient(Settings(url="http://vibecad.test", timeout_s=7), httpx2.MockTransport(hang))
    with pytest.raises(VibecadError, match="did not respond within 7 s"):
        await api.raster_3d({"script": "x"})
    await api.aclose()


async def test_uses_the_configured_timeout() -> None:
    api = VibecadClient(Settings(timeout_s=3.5))
    assert api._http.timeout.read == 3.5
    await api.aclose()
