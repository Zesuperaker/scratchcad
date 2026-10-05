// The server's MCP instructions: how to write scripts and use the tools.
export const GUIDE = `scratchcad models solids as implicit surfaces written in Rhai scripts. The field is negative inside the shape, zero on the surface and positive outside.

A script produces its shape in one of two ways:
- it calls draw(shape) exactly once, or
- its last expression is a shape.

Math: the variables x, y and z, arithmetic, min, max, abs, sqrt, square, sin, cos, tan, asin, acos, atan, exp, ln, floor, ceil, round, remap. For example \`sqrt(x*x + y*y + z*z) - 1\` is a unit sphere. min(a, b) is a union and max(a, b) is an intersection.

Shapes take a map of named fields (points are [x, y, z] arrays and angles are in degrees):
- sphere(#{ radius: 1.0, center: [0, 0, 0] })
- box(#{ lower: [-1, -1, -1], upper: [1, 1, 1] })
- circle(#{ radius: 1.0, center: [0, 0] }) and rectangle(#{ lower: [x, y], upper: [x, y] }) are 2D, so they extend forever along z. Use extrude_z to cap them.
- union([a, b, ...]), intersection([a, b, ...])
- difference(#{ shape: a, cutout: b }), inverse(#{ shape: a })
- blend(#{ a: a, b: b, radius: 0.1 }) is a smooth union
- move(#{ shape: a, offset: [dx, dy, dz] }), scale(#{ shape: a, scale: [sx, sy, sz] }), scale_uniform(#{ shape: a, scale: 2.0 })
- rotate_x / rotate_y / rotate_z(#{ shape: a, angle: 90.0, center: [0, 0, 0] })
- extrude_z(#{ shape: profile2d, lower: -1, upper: 1 }), loft_z(#{ a: p, b: q, lower, upper })
- revolve_y(#{ shape: profile2d, offset: 0.0 }), repeat_x(#{ shape: a, radius, offset })
- reflect_x / reflect_y / reflect_z(#{ shape: a, offset: 0.0 })
Fields with defaults (center, offset) can be left out. Shapes also work as methods: sphere(#{ radius: 1.0 }).move([1, 0, 0]).

Units are whatever you choose. Most slicers read STL files as millimetres. Every render and the STL export only cover the cube center ± half_size (default ±1), so set center and half_size to enclose the whole part, or it will be clipped. render_3d rotates that cube, so its half_size must also cover the part's corners: use at least the distance from center to the farthest point (about 1.75 times the half-width for a cube). A flat, brightly lit cut face that is not part of the design means the view is too small.

Renders skip samples where the field is NaN or infinite; export_stl fails with non_finite_field when the mesher meets one. Renders and exports also return warnings: where the field is NaN or infinite in the view, and which sides of the region the shape reaches.

Workflow: validate_script first to catch errors cheaply, then render_3d to see the shape, render_2d for a cross-section at z = 0 (move or rotate the shape to slice elsewhere), evaluate to check exact dimensions (a point is inside when its value is negative), and save_script once it looks right.

The saved .rhai script is the deliverable: the user opens it in the scratchcad editor, which previews it, lets them change it and exports STL files. save_script returns the editor link for the script (editor_url) when the editor is running; give it to the user. Only call export_stl when the user asks for an STL. Pass save_script the center and half_size that enclose the part; it records them on the script's first line so the editor meshes the right region.

Parameters: most users never read the script. They change the part with sliders that the editor builds from top-level \`let\` lines, so design those lines for them:
- Write one line per dimension a user might reasonably change, at the top of the script after the region line, in the form \`let name = value; // [min, max] Label (unit)\`. Typically 3 to 12 of them, the most important first.
- The label is what the user reads next to the slider. Write it in plain words, as the user would say it, with the unit in brackets: "Thread length (mm)", "Number of blades", "Twist angle (degrees)". Avoid internal jargon and abbreviations.
- The name is a snake_case variable the rest of the script uses: \`thread_length\`, not \`tl\` or \`p1\`.
- Always give [min, max]. Pick a range over which the part stays valid and sensible, and include the current value. Without a range the slider has to guess one.
- Compute everything that follows from the parameters (clearances, derived radii, positions) in the script body, not as more parameters, so the part stays consistent whichever slider moves. If one parameter limits another, choose ranges that can't break the part, or clamp in the body with min/max.
- Counts are integers (\`let holes = 4;\`), as loops like \`for i in 0..holes\` need one; lengths and angles are floats with a decimal point (\`let width = 20.0;\`), as integer division truncates (\`7 / 2\` is 3). The slider keeps each literal's kind.
- Group related parameters under a section line, \`// # Head\`, which the editor shows as a heading.
- Make sure the region (save_script's center and half_size) encloses the part at the largest values of the parameters, not just the current ones.
For example:
  // # Thread
  let thread_length = 26.0; // [10, 60] Thread length (mm)
  let thread_pitch = 1.5; // [0.5, 3.0] Thread pitch (mm)
  // # Head
  let head_height = 6.4; // [3.0, 12.0] Head height (mm)
  let head_width = 16.0; // [10.0, 30.0] Head width across flats (mm)
save_script lists the sliders it found and notes any that are unclear; fix those and save again.

The user may edit a saved script in the editor at any time. Before changing a script you saved earlier, read_script it again and build on what is there.`;
