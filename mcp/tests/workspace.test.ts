// Path rules, the region line and file writes, without the server around them.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as workspace from "../src/workspace.ts";
import { MESH, SCRIPT, WorkspaceError } from "../src/workspace.ts";
import { tempDir, writeFile } from "./helpers.ts";

describe("resolve", () => {
  it("accepts paths inside the output directory", () => {
    const out = tempDir();
    expect(workspace.resolve(out, "a/b.rhai", [SCRIPT])).toBe(path.join(out, "a/b.rhai"));
    expect(workspace.resolve(out, path.join(out, "c.STL"), [SCRIPT, MESH])).toBe(
      path.join(out, "c.STL"),
    );
  });

  it.each([
    ["", "must not be empty"],
    ["../x.rhai", "inside the output directory"],
    [".", "inside the output directory"],
    ["x.txt", "end in .rhai or .stl"],
  ])("refuses '%s'", (relative, message) => {
    expect(() => workspace.resolve(tempDir(), relative, [SCRIPT, MESH])).toThrow(message);
  });

  it("follows symlinks, dangling ones included", () => {
    const out = tempDir();
    const outside = tempDir();
    fs.symlinkSync(path.join(outside, "missing.rhai"), path.join(out, "dangling.rhai"));
    expect(() => workspace.resolve(out, "dangling.rhai", [SCRIPT])).toThrow(WorkspaceError);
    fs.symlinkSync("inside.rhai", path.join(out, "relative.rhai"));
    expect(workspace.resolve(out, "relative.rhai", [SCRIPT])).toBe(path.join(out, "inside.rhai"));
  });

  it("gives up on symlink loops", () => {
    const out = tempDir();
    fs.symlinkSync("b.rhai", path.join(out, "a.rhai"));
    fs.symlinkSync("a.rhai", path.join(out, "b.rhai"));
    expect(() => workspace.resolve(out, "a.rhai", [SCRIPT])).toThrow("too many levels");
  });

  it("resolves an output directory that doesn't exist yet", () => {
    const out = path.join(tempDir(), "not", "yet");
    expect(workspace.resolve(out, "a.rhai", [SCRIPT])).toBe(path.join(out, "a.rhai"));
    expect(workspace.realpath("/")).toBe("/");
  });
});

describe("listFiles", () => {
  it("lists scripts and meshes newest first, skipping the rest", () => {
    const out = tempDir();
    writeFile(path.join(out, "old.stl"), "a", 1000);
    writeFile(path.join(out, "parts/new.RHAI"), "bbb", 3000);
    writeFile(path.join(out, "b.stl"), "cc", 2000);
    writeFile(path.join(out, "a.rhai"), "cc", 2000);
    writeFile(path.join(out, "notes.txt"), "x", 4000);
    writeFile(path.join(out, ".cache/hidden.stl"), "x", 5000);
    fs.mkdirSync(path.join(out, "folder.stl"));
    fs.symlinkSync(path.join(out, "missing.stl"), path.join(out, "gone.stl"));
    const outside = path.join(tempDir(), "secret.rhai");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(out, "link.rhai"));
    expect(workspace.listFiles(out).map((e) => [e.path, e.kind, e.bytes, e.modified])).toEqual([
      ["parts/new.RHAI", "script", 3, 3000],
      ["a.rhai", "script", 2, 2000],
      ["b.stl", "mesh", 2, 2000],
      ["old.stl", "mesh", 1, 1000],
    ]);
  });

  it("skips dependency and build trees, and very deep directories", () => {
    const out = tempDir();
    writeFile(path.join(out, "node_modules/pkg/a.rhai"), "x", 1000);
    writeFile(path.join(out, "target/debug/b.stl"), "x", 1000);
    writeFile(path.join(out, "1/2/3/4/5/6/7/8/deepest.rhai"), "x", 1000);
    writeFile(path.join(out, "1/2/3/4/5/6/7/8/9/too-deep.rhai"), "x", 1000);
    expect(workspace.listFiles(out).map((e) => e.path)).toEqual(["1/2/3/4/5/6/7/8/deepest.rhai"]);
  });

  it("is empty for a missing directory", () => {
    expect(workspace.listFiles(path.join(tempDir(), "nope"))).toEqual([]);
  });
});

describe("write and version", () => {
  it("writes atomically, leaving no temporary file", () => {
    const target = path.join(tempDir(), "deep", "a.rhai");
    workspace.write(target, "one");
    workspace.write(target, Buffer.from("two"));
    expect(fs.readFileSync(target, "utf8")).toBe("two");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["a.rhai"]);
  });

  it("changes the version when the file changes", () => {
    const target = path.join(tempDir(), "a.rhai");
    writeFile(target, "one", 1000);
    const before = workspace.version(target);
    writeFile(target, "three", 1000);
    expect(workspace.version(target)).not.toBe(before);
    expect(workspace.entry(path.dirname(target), target).version).toBe(workspace.version(target));
  });
});

describe("withRegion", () => {
  const region = { center: [0, 0, 1] as [number, number, number], halfSize: 2 };
  it("adds or replaces the region line, ending with one newline", () => {
    expect(workspace.withRegion("draw(x);", region)).toBe(
      "// region: center=[0, 0, 1] half_size=2\ndraw(x);\n",
    );
    expect(
      workspace.withRegion("// region: center=[9, 9, 9] half_size=9\ndraw(x);\n\n", region),
    ).toBe("// region: center=[0, 0, 1] half_size=2\ndraw(x);\n");
  });
});
