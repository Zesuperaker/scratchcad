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

Put the dimensions someone might want to change in top-level \`let\` lines at the start of the script, one per line, with an optional [min, max] range and a description in a trailing comment. The editor turns them into sliders:
  let thread_length = 26.0; // [10, 60] Thread length (mm)
  let blade_count = 29; // [3, 60] Number of blades
Keep integers as integers and floats with a decimal point, as Rhai is strict about mixing them.

The user may edit a saved script in the editor at any time. Before changing a script you saved earlier, read_script it again and build on what is there.`;
