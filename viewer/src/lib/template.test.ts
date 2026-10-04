import { expect, it } from "vitest";
import { parseParams } from "./params";
import { parseRegion } from "./region";
import { NEW_SCRIPT } from "./template";

it("starts new scripts with a region line and slider parameters", () => {
  expect(parseRegion(NEW_SCRIPT)).toEqual({ center: [0, 0, 0], halfSize: 20 });
  const params = parseParams(NEW_SCRIPT);
  expect(params.map((p) => p.name)).toEqual(["width", "height", "hole"]);
  // The widest block (36 wide, half of it deep) still fits the region.
  expect(params[0]!.max / 2).toBeLessThan(20);
});
