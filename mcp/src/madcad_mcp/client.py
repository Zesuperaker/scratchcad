"""A small async client for the madcad HTTP API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypeVar

import httpx2

from .config import Settings

_N = TypeVar("_N", int, float)

# Longest excerpt of a non-JSON error body that is passed on to the model.
_MAX_BODY_EXCERPT = 500


class MadcadError(Exception):
    """A request to madcad failed. The message is written for the model to read."""

    def __init__(self, message: str, *, code: str | None = None, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class BinaryResult:
    """A PNG or STL response, with the metadata madcad sends in headers."""

    data: bytes
    compute_ms: float | None
    triangles: int | None = None


class MadcadClient:
    def __init__(self, settings: Settings, transport: httpx2.AsyncBaseTransport | None = None):
        headers = {"user-agent": "madcad-mcp"}
        if settings.api_token:
            headers["authorization"] = f"Bearer {settings.api_token}"
        self._url = settings.url
        self._timeout_s = settings.timeout_s
        self._http = httpx2.AsyncClient(
            base_url=settings.url,
            headers=headers,
            timeout=settings.timeout_s,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def validate(self, body: dict[str, Any]) -> dict[str, Any]:
        return _json(await self._post("/v1/scripts/validate", body))

    async def eval(self, body: dict[str, Any]) -> dict[str, Any]:
        return _json(await self._post("/v1/eval", body))

    async def raster_2d(self, body: dict[str, Any]) -> BinaryResult:
        return _binary(await self._post("/v1/raster/2d", body))

    async def raster_3d(self, body: dict[str, Any]) -> BinaryResult:
        return _binary(await self._post("/v1/raster/3d", body))

    async def export_stl(self, body: dict[str, Any]) -> BinaryResult:
        return _binary(await self._post("/v1/export/stl", body))

    async def _post(self, path: str, body: dict[str, Any]) -> httpx2.Response:
        try:
            response = await self._http.post(path, json=body)
        except httpx2.TimeoutException:
            raise MadcadError(
                f"madcad at {self._url} did not respond within {self._timeout_s:g} s"
            ) from None
        except httpx2.TransportError as exc:
            raise MadcadError(
                f"could not reach madcad at {self._url} ({type(exc).__name__}: {exc}). "
                "Is the server running?"
            ) from None
        if response.is_error:
            raise _error_from(response)
        return response


def _json(response: httpx2.Response) -> dict[str, Any]:
    data: dict[str, Any] = response.json()
    return data


def _binary(response: httpx2.Response) -> BinaryResult:
    return BinaryResult(
        data=response.content,
        compute_ms=_header_number(response, "x-compute-ms", float),
        triangles=_header_number(response, "x-triangle-count", int),
    )


def _header_number(response: httpx2.Response, name: str, kind: type[_N]) -> _N | None:
    value = response.headers.get(name)
    if value is None:
        return None
    try:
        return kind(value)
    except ValueError:
        return None


def _error_from(response: httpx2.Response) -> MadcadError:
    status = response.status_code
    code = message = None
    try:
        error = response.json()["error"]
        code, message = str(error["code"]), str(error["message"])
    except (ValueError, KeyError, TypeError):
        pass

    if code is None:
        excerpt = response.text[:_MAX_BODY_EXCERPT].strip() or response.reason_phrase
        return MadcadError(f"madcad returned HTTP {status}: {excerpt}", status=status)

    text = f"{code}: {message}"
    if code == "unauthorized":
        text += " (set MADCAD_API_TOKEN to the token the madcad server was started with)"
    elif code == "overloaded":
        text += " (the server is busy; retry in a moment)"
    elif code == "limit_exceeded":
        text += " (reduce the size, resolution or complexity of the request)"
    return MadcadError(text, code=code, status=status)
