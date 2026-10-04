"""Path rules, the region line and file writes, without the server around them."""

from pathlib import Path

import pytest

from scratchcad_mcp import workspace
from scratchcad_mcp.workspace import Region


@pytest.mark.parametrize(
    ("line", "region"),
    [
        ("// region: center=[0, 0, 0] half_size=1", Region((0, 0, 0), 1)),
        ("//region:center=[ -1.5 ,2,3e2] half_size=0.25  ", Region((-1.5, 2, 300), 0.25)),
        ("// region: center=[1, 2] half_size=1", None),
        ("// region: center=[a, b, c] half_size=1", None),
        ("// region: center=[0, 0, 0]", None),
        ("let x = 1;", None),
    ],
)
def test_parse_region(line: str, region: Region | None) -> None:
    assert workspace.parse_region(f"{line}\ndraw(x);") == region


def test_region_header_round_trips() -> None:
    for region in (Region(), Region((0.1, -2, 1e-7), 37.5), Region((1e20, 0, 0), 3)):
        assert workspace.parse_region(region.header()) == region
    assert Region((1, 2, 3), 30).header() == "// region: center=[1, 2, 3] half_size=30"


def test_with_region_adds_or_replaces_the_first_line() -> None:
    region = Region((0, 0, 1), 2)
    assert workspace.with_region("draw(x);", region) == f"{region.header()}\ndraw(x);\n"
    old = "// region: center=[9, 9, 9] half_size=9\r\ndraw(x);\n\n"
    assert workspace.with_region(old, region) == f"{region.header()}\ndraw(x);\n"


def test_write_is_atomic_and_leaves_no_temporary_file(tmp_path: Path) -> None:
    target = tmp_path / "deep" / "a.rhai"
    workspace.write(target, b"one")
    workspace.write(target, b"two")
    assert target.read_bytes() == b"two"
    assert [p.name for p in target.parent.iterdir()] == ["a.rhai"]


def test_version_changes_when_the_file_does(tmp_path: Path) -> None:
    target = tmp_path / "a.rhai"
    target.write_bytes(b"one")
    before = workspace.version(target)
    target.write_bytes(b"three")
    assert workspace.version(target) != before


def test_list_files_skips_dangling_symlinks(tmp_path: Path) -> None:
    (tmp_path / "gone.stl").symlink_to(tmp_path / "missing.stl")
    (tmp_path / "here.rhai").write_text("draw(x);")
    assert [entry.path for entry in workspace.list_files(tmp_path)] == ["here.rhai"]
