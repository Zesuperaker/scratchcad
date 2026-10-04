"""The output directory as a workspace of Rhai scripts and STL meshes.

The agent's save_script / read_script / export_stl tools and the editor's
/files routes both go through here, so they share one set of path rules:
only .rhai and .stl files, only inside the output directory (symlinks
included).
"""

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

SCRIPT = ".rhai"
MESH = ".stl"
Kind = Literal["script", "mesh"]
KINDS: dict[str, Kind] = {SCRIPT: "script", MESH: "mesh"}

# The first line of a saved script may record the region to mesh, so the
# editor can preview and export it without asking:
#   // region: center=[0, 0, 0] half_size=30
REGION = re.compile(
    r"^//\s*region:\s*center=\[\s*([^\],]+),\s*([^\],]+),\s*([^\],]+)\]\s+"
    r"half_size=(\S+)\s*$"
)


class WorkspaceError(Exception):
    """A path or file the workspace refuses; the message says why."""


@dataclass(frozen=True)
class Region:
    center: tuple[float, float, float] = (0.0, 0.0, 0.0)
    half_size: float = 1.0

    def header(self) -> str:
        center = ", ".join(_number(c) for c in self.center)
        return f"// region: center=[{center}] half_size={_number(self.half_size)}"


@dataclass(frozen=True)
class Entry:
    path: str
    kind: Kind
    bytes: int
    modified: float
    version: str


def resolve(output_dir: Path, path: str, suffixes: tuple[str, ...]) -> Path:
    """The absolute path for `path` inside the output directory.

    Raises WorkspaceError if it is empty, leaves the directory (through `..`,
    an absolute path or a symlink), has another suffix, or is a directory.
    """
    if not path.strip():
        raise WorkspaceError("path must not be empty")
    output_dir = output_dir.resolve()
    target = (output_dir / path).resolve()
    if not target.is_relative_to(output_dir):
        raise WorkspaceError(f"path must stay inside the output directory {output_dir}")
    if target.suffix.lower() not in suffixes:
        raise WorkspaceError(f"path must end in {' or '.join(suffixes)}")
    if target.is_dir():
        raise WorkspaceError(f"{target} is a directory")
    return target


def version(target: Path) -> str:
    """Changes whenever the file is rewritten; used to detect edit conflicts."""
    stat = target.stat()
    return f"{stat.st_mtime_ns}-{stat.st_size}"


def entry(output_dir: Path, target: Path) -> Entry:
    stat = target.stat()
    return Entry(
        path=target.relative_to(output_dir.resolve()).as_posix(),
        kind=KINDS[target.suffix.lower()],
        bytes=stat.st_size,
        modified=stat.st_mtime,
        version=version(target),
    )


def list_files(output_dir: Path) -> list[Entry]:
    """Every script and mesh under the output directory, newest first.

    Hidden directories are skipped, and so are symlinks that lead out of the
    directory.
    """
    output_dir = output_dir.resolve()
    entries = []
    for directory, subdirs, names in output_dir.walk():
        subdirs[:] = [name for name in subdirs if not name.startswith(".")]
        for name in names:
            relative = (directory / name).relative_to(output_dir).as_posix()
            try:
                target = resolve(output_dir, relative, (SCRIPT, MESH))
            except WorkspaceError:
                continue
            if target.is_file():
                entries.append(entry(output_dir, target))
    entries.sort(key=lambda e: (-e.modified, e.path))
    return entries


def write(target: Path, data: bytes) -> None:
    """Write the file atomically, so a reader never sees half of it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        temporary.write_bytes(data)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def parse_region(script: str) -> Region | None:
    """The region recorded on the script's first line, if there is one."""
    first = script.split("\n", 1)[0].strip()
    match = REGION.match(first)
    if match is None:
        return None
    try:
        x, y, z, half_size = (float(group) for group in match.groups())
    except ValueError:
        return None
    return Region(center=(x, y, z), half_size=half_size)


def with_region(script: str, region: Region) -> str:
    """The script with its region line replaced (or added) and a final newline."""
    body = script.split("\n", 1)[1] if parse_region(script) else script
    return f"{region.header()}\n{body.rstrip()}\n"


def _number(value: float) -> str:
    """Shortest exact form, without a trailing `.0`: 30, 2.5, 1e-07."""
    text = repr(float(value))
    return text.removesuffix(".0")
