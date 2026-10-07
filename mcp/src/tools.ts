// The MCP tools: the scratchcad API, plus saving and reading scripts in the
// local output directory.
import fs from "node:fs";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type BinaryResult, type Body, ScratchcadClient, ScratchcadError } from "./client.ts";
import { GUIDE } from "./guide.ts";
import { checkParams, parseParams } from "./shared/params.ts";
import * as workspace from "./workspace.ts";
import { MESH, SCRIPT, WorkspaceError } from "./workspace.ts";

export interface ToolOptions {
  client: ScratchcadClient;
  outputDir: string;
  /** Where the editor is served, if it is; save_script links scripts to it. */
  editorUrl: string | null;
  version: string;
}

/** A failure the model should see verbatim (anything else is masked). */
export class ToolError extends Error {
  override name = "ToolError";
}

const script = z
  .string()
  .describe("Rhai script that draws the shape. See the server instructions.");
const evaluator = z
  .enum(["jit", "vm"])
  .optional()
  .describe("Evaluator backend. Leave unset for the server default (jit).");
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const center3 = vec3.describe("Model-space point at the middle of the view.");
const halfSize = z
  .number()
  .gt(0)
  .describe("The region covered is center ± half_size on each axis.");
const pixels = z.number().int().min(1).describe("Image size in pixels.");

const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const writing = { readOnlyHint: false, destructiveHint: true };

const looseObject = z.looseObject({});

const stlExport = z.object({
  path: z.string().describe("Absolute path of the written STL file."),
  bytes: z.number().int(),
  triangles: z.number().int().nullable(),
  compute_ms: z.number().nullable(),
  warnings: z
    .array(z.string())
    .describe(
      "Observations that did not stop the export, such as the sides of the region the shape reaches.",
    ),
});

const savedScript = z.object({
  path: z.string().describe("Absolute path of the written .rhai file."),
  bytes: z.number().int(),
  nodes: z.number().int().describe("Node count of the script's math graph."),
  center: vec3,
  half_size: z.number(),
  editor_url: z
    .string()
    .nullable()
    .describe("Link that opens the script in the editor; null when the editor is not running."),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        section: z.string(),
        value: z.number(),
        min: z.number(),
        max: z.number(),
      }),
    )
    .describe("The sliders the editor shows for this script, in order."),
  notes: z
    .array(z.string())
    .describe(
      "Problems with the parameters that make the sliders hard to use. Fix them and save again.",
    ),
});

const scriptFile = z.object({
  path: z.string().describe("Absolute path of the .rhai file."),
  script: z.string().describe("The file's text, including its region line."),
  center: vec3.nullable().describe("Center from the region line, if it has one."),
  half_size: z.number().nullable().describe("half_size from the region line, if any."),
});

/** Leave unset options out of the request so the server applies its defaults. */
function dropUndefined(body: Body): Body {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function structured<T extends Record<string, unknown>>(value: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

/** The rendered PNG, followed by a text block for each warning. */
function image(result: BinaryResult): CallToolResult {
  return {
    content: [
      { type: "image", data: result.data.toString("base64"), mimeType: "image/png" },
      ...result.warnings.map((w) => ({ type: "text" as const, text: `Warning: ${w}` })),
    ],
  };
}

/**
 * Runs a tool body, turning expected failures into tool errors the model can
 * act on, and hiding the details of anything unexpected.
 */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    const expected =
      error instanceof ToolError ||
      error instanceof ScratchcadError ||
      error instanceof WorkspaceError;
    if (!expected) console.error("scratchcad-mcp: unexpected error in a tool:", error);
    const text = expected ? error.message : "Error calling tool: an internal error occurred";
    return { content: [{ type: "text", text }], isError: true };
  }
}

/** Where a tool may write `relative`, or a ToolError saying why it may not. */
function writable(outputDir: string, relative: string, suffix: string, overwrite: boolean) {
  const target = workspace.resolve(outputDir, relative, [suffix]);
  if (fs.existsSync(target) && !overwrite) {
    throw new ToolError(`${target} already exists; pass overwrite=true to replace it`);
  }
  return target;
}

export function createMcpServer({ client, outputDir, editorUrl, version }: ToolOptions): McpServer {
  const server = new McpServer({ name: "scratchcad", version }, { instructions: GUIDE });

  server.registerTool(
    "validate_script",
    {
      description:
        "Check a script without rendering it.\n\nReturns the node count of the resulting math " +
        "graph, anything the script printed and the compile time. Errors include the line and column.",
      inputSchema: z.strictObject({ script }),
      outputSchema: looseObject,
      annotations: readOnly,
    },
    (args) => guard(async () => structured(await client.validate({ script: args.script }))),
  );

  server.registerTool(
    "evaluate",
    {
      description:
        "Sample the field exactly, to measure the shape rather than eyeball it.\n\nA negative " +
        "value means the point is inside. gradient mode also returns the surface normal " +
        "direction. interval mode returns conservative [lower, upper] bounds over each box: an " +
        "upper bound below zero means the box is entirely solid, and a lower bound above zero " +
        "means it is empty.",
      inputSchema: z.strictObject({
        script,
        mode: z
          .enum(["value", "gradient", "interval"])
          .default("value")
          .describe("value and gradient use points; interval uses intervals."),
        points: z
          .array(vec3)
          .optional()
          .describe("Points [x, y, z] to sample, for value and gradient modes."),
        intervals: z
          .array(
            z.tuple([
              z.tuple([z.number(), z.number()]),
              z.tuple([z.number(), z.number()]),
              z.tuple([z.number(), z.number()]),
            ]),
          )
          .optional()
          .describe("Boxes [[xmin, xmax], [ymin, ymax], [zmin, zmax]], for interval mode."),
        evaluator,
      }),
      outputSchema: looseObject,
      annotations: readOnly,
    },
    (args) => guard(async () => structured(await client.eval(dropUndefined(args)))),
  );

  server.registerTool(
    "render_2d",
    {
      description:
        "Render the cross-section at z = 0 as a PNG.\n\nUse it to see inside a part: holes, " +
        "wall thickness and internal features. To slice at another height, move the shape in " +
        "the script.",
      inputSchema: z.strictObject({
        script,
        width: pixels.default(512),
        height: pixels.default(512),
        mode: z
          .enum(["mono", "sdf", "debug"])
          .default("mono")
          .describe(
            "mono is white on black, sdf colours by distance, debug shows interval levels.",
          ),
        center: z
          .tuple([z.number(), z.number()])
          .default([0, 0])
          .describe("Model-space point at the image center."),
        half_size: halfSize.default(1),
        evaluator,
      }),
      annotations: readOnly,
    },
    (args) => guard(async () => image(await client.raster2d(dropUndefined(args)))),
  );

  server.registerTool(
    "render_3d",
    {
      description:
        "Render a shaded 3D view of the shape as a PNG with a transparent background.\n\nWith " +
        "no rotation the camera looks along -z with +y up. The default angle turns the part " +
        "slightly so three faces show. Render several angles to check a part from all sides.",
      inputSchema: z.strictObject({
        script,
        width: pixels.default(512),
        height: pixels.default(512),
        yaw: z.number().default(30).describe("Degrees about the Y axis."),
        pitch: z.number().default(-20).describe("Degrees about the X axis."),
        roll: z.number().default(0).describe("Degrees about the Z axis."),
        center: center3.default([0, 0, 0]),
        half_size: halfSize.default(1),
        mode: z
          .enum(["shaded", "normals", "heightmap"])
          .default("shaded")
          .describe("Shading style."),
        ssao: z.boolean().default(true).describe("Ambient occlusion (shaded mode only)."),
        perspective: z.number().min(0).max(1).default(0).describe("0 is orthographic, up to 1."),
        depth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Voxels along the view axis. Defaults to max(width, height)."),
        evaluator,
      }),
      annotations: readOnly,
    },
    ({ yaw, pitch, roll, ssao, ...args }) =>
      guard(async () =>
        image(
          await client.raster3d(
            dropUndefined({
              ...args,
              ssao: args.mode === "shaded" ? ssao : undefined,
              rotation: { yaw, pitch, roll },
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "export_stl",
    {
      description:
        "Mesh the shape and save it as a binary STL file.\n\nVertices are in model coordinates. " +
        "Only the cube center ± half_size is meshed, so make it enclose the whole part.",
      inputSchema: z.strictObject({
        script,
        path: z
          .string()
          .describe(
            "Where to write the .stl file, relative to the output directory " +
              "(SCRATCHCAD_MCP_OUTPUT_DIR). It cannot leave that directory.",
          ),
        center: center3.default([0, 0, 0]),
        half_size: halfSize.default(1),
        depth: z
          .number()
          .int()
          .min(1)
          .default(6)
          .describe("Octree depth; the mesh has 2^depth cells per axis."),
        overwrite: z.boolean().default(false).describe("Replace the file if it already exists."),
        evaluator,
      }),
      outputSchema: stlExport,
      annotations: writing,
    },
    ({ path, overwrite, ...args }) =>
      guard(async () => {
        const target = writable(outputDir, path, MESH, overwrite);
        const result = await client.exportStl(dropUndefined(args));
        workspace.write(target, result.data);
        return structured({
          path: target,
          bytes: result.data.length,
          triangles: result.triangles,
          compute_ms: result.computeMs,
          warnings: result.warnings,
        });
      }),
  );

  server.registerTool(
    "save_script",
    {
      description:
        "Check the script and save it as a .rhai file the user can open in the editor.\n\nThis " +
        "is how a finished part is delivered. The first line of the file records the region " +
        "(center and half_size) the editor meshes. The result lists the sliders the user will " +
        "see and notes on any that are unclear; fix those and save again (overwrite=true).",
      inputSchema: z.strictObject({
        script,
        path: z
          .string()
          .describe(
            "Where to write the .rhai file, relative to the output directory " +
              "(SCRATCHCAD_MCP_OUTPUT_DIR). It cannot leave that directory.",
          ),
        center: vec3
          .optional()
          .describe(
            "Center of the region that encloses the part. Leave unset to keep the script's " +
              "existing region line, or (0, 0, 0).",
          ),
        half_size: z
          .number()
          .gt(0)
          .optional()
          .describe(
            "The region is center ± half_size on each axis. Leave unset to keep the script's " +
              "existing region line, or 1.",
          ),
        overwrite: z.boolean().default(false).describe("Replace the file if it already exists."),
      }),
      outputSchema: savedScript,
      annotations: writing,
    },
    (args) =>
      guard(async () => {
        const target = writable(outputDir, args.path, SCRIPT, args.overwrite);
        const existing = workspace.parseRegion(args.script);
        const region = {
          center: args.center ?? existing?.center ?? [0, 0, 0],
          halfSize: args.half_size ?? existing?.halfSize ?? 1,
        } satisfies workspace.Region;
        const checked = await client.validate({ script: args.script });
        const text = workspace.withRegion(args.script, region);
        const params = parseParams(text);
        workspace.write(target, text);
        const relative = workspace.entry(outputDir, target).path;
        return structured({
          path: target,
          bytes: Buffer.byteLength(text),
          nodes: checked.nodes as number,
          center: region.center,
          half_size: region.halfSize,
          editor_url: editorUrl && `${editorUrl}?open=${encodeURIComponent(relative)}`,
          parameters: params.map(({ name, label, section, value, min, max }) => ({
            name,
            label,
            section,
            value,
            min,
            max,
          })),
          notes: checkParams(params),
        });
      }),
  );

  server.registerTool(
    "read_script",
    {
      description: "Read a saved script, including any changes the user made in the editor.",
      inputSchema: z.strictObject({
        path: z.string().describe("The .rhai file to read, relative to the output directory."),
      }),
      outputSchema: scriptFile,
      annotations: readOnly,
    },
    (args) =>
      guard(async () => {
        const target = workspace.resolve(outputDir, args.path, [SCRIPT]);
        if (!workspace.isFile(target)) throw new ToolError(`${args.path} does not exist`);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(target));
        } catch {
          throw new ToolError(`${args.path} is not UTF-8 text`);
        }
        const region = workspace.parseRegion(text);
        return structured({
          path: target,
          script: text,
          center: region?.center ?? null,
          half_size: region?.halfSize ?? null,
        });
      }),
  );

  return server;
}
