/** The script a new file starts with: small, valid, and showing the conventions. */
export const NEW_SCRIPT = `// region: center=[0, 0, 0] half_size=20
// A block with a hole through it. Drag the sliders, or edit the script.
// The first line is the region the editor meshes.
// # Block
let width = 30.0; // [10, 36] Width (mm)
let height = 12.0; // [4, 30] Height (mm)
// # Hole
let hole = 5.0; // [1, 7] Hole radius (mm)

let block = box(#{
    lower: [-width / 2.0, -height / 2.0, -width / 4.0],
    upper: [width / 2.0, height / 2.0, width / 4.0],
});
let bore = rotate_x(#{ shape: circle(#{ radius: hole }), angle: 90.0 });
draw(difference(#{ shape: block, cutout: bore }));
`;
