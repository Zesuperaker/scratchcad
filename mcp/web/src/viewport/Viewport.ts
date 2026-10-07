// The 3D view: an STL mesh with orbit controls, a ground grid and a view
// cube. Plain three.js, owned by the React <ViewportView> component.
//
// Axes follow render_3d: +y is up and the unrotated camera looks along -z, so
// the view cube's Front face is +z and its Top face is +y.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

// Edges sharper than this stay sharp; gentler ones are smoothed, which hides
// the faceting of meshed curved surfaces.
const CREASE_ANGLE = THREE.MathUtils.degToRad(30);
const TURN_MS = 300;
const FLY_MS = 250;
// Auto-fit reframes once the part's bounding sphere has grown, shrunk or
// moved by more than this fraction of its radius since the last fit.
const REFIT_TOLERANCE = 0.03;
// Margin around the part when it's framed.
const FRAME_MARGIN = 1.1;

export interface MeshInfo {
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
}

interface Turn {
  start: THREE.Vector3;
  rotation: THREE.Quaternion;
  began: number;
}

/** A glide of the orbit target and distance, keeping the viewing direction. */
interface Fly {
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromDistance: number;
  toDistance: number;
  began: number;
}

/** How show() treats the camera: frame a new file, or follow a changed part. */
export type Framing = "reset" | "follow";

export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly controls: OrbitControls;
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0x9aa7b8,
    metalness: 0.1,
    roughness: 0.6,
  });
  private readonly loader = new STLLoader();
  private readonly cube: ViewCube;
  private readonly resizeObserver: ResizeObserver;
  private mesh: THREE.Mesh | null = null;
  private grid: THREE.GridHelper | null = null;
  private turn: Turn | null = null;
  private fly: Fly | null = null;
  private autoFit = true;
  /** The bounding sphere the camera was last fitted to. */
  private fitted: THREE.Sphere | null = null;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, cubeCanvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.camera.position.set(1, 1, 2);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8888aa, 1.6));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    headlight.position.set(0.5, 1, 1);
    this.camera.add(headlight);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    // Grabbing the view hands the camera back to the user mid-glide.
    this.controls.addEventListener("start", () => (this.fly = null));

    this.cube = new ViewCube(cubeCanvas, (direction) => this.lookFrom(direction));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clear();
    this.material.dispose();
    this.renderer.dispose();
    this.cube.dispose();
  }

  /**
   * Shows an STL. "reset" frames it from the default three-quarter view (a
   * newly opened file); "follow" keeps the user's view but, with auto-fit on,
   * glides to fit the part when it has changed size or moved.
   */
  show(stl: ArrayBuffer, framing: Framing): MeshInfo {
    const geometry = toCreasedNormals(this.loader.parse(stl), CREASE_ANGLE);
    geometry.computeBoundingBox();
    this.clear();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.mesh);

    const box = geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, 1e-6) * 2;
    this.grid = new THREE.GridHelper(extent, 20, 0x888888, 0x888888);
    const gridMaterial = this.grid.material as THREE.Material;
    gridMaterial.opacity = 0.25;
    gridMaterial.transparent = true;
    this.grid.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    this.scene.add(this.grid);

    if (framing === "reset") this.frame();
    else if (this.autoFit && this.outgrown()) this.fit(true);
    return {
      triangles: geometry.attributes.position!.count / 3,
      min: box.min.toArray(),
      max: box.max.toArray(),
    };
  }

  clear(): void {
    for (const object of [this.mesh, this.grid]) {
      if (!object) continue;
      object.geometry.dispose();
      this.scene.remove(object);
    }
    if (this.grid) (this.grid.material as THREE.Material).dispose();
    this.mesh = null;
    this.grid = null;
  }

  /** With auto-fit on, the camera follows the part as it changes. */
  setAutoFit(on: boolean): void {
    this.autoFit = on;
    if (on && this.mesh) this.fit(true);
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
  }

  /** Dims the mesh, e.g. while it no longer matches the script. */
  setStale(stale: boolean): void {
    this.material.transparent = stale;
    this.material.opacity = stale ? 0.45 : 1;
  }

  /** Points the camera at the whole mesh from the default three-quarter view. */
  frame(): void {
    this.turn = null;
    this.fly = null;
    if (!this.mesh) return;
    const sphere = this.sphere();
    const direction = new THREE.Vector3(0.6, 0.45, 1).normalize();
    const distance = this.distanceFor(sphere.radius);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.controls.target.copy(sphere.center);
    this.setClipping(distance);
    this.controls.update();
    this.fitted = sphere;
  }

  /** Fits the camera to the mesh from the direction it's looking now. */
  private fit(animate: boolean): void {
    const sphere = this.sphere();
    const toDistance = this.distanceFor(sphere.radius);
    this.fitted = sphere;
    this.setClipping(Math.max(toDistance, this.camera.position.distanceTo(this.controls.target)));
    this.fly = {
      fromTarget: this.controls.target.clone(),
      toTarget: sphere.center.clone(),
      fromDistance: this.camera.position.distanceTo(this.controls.target),
      toDistance,
      began: animate ? performance.now() : -Infinity,
    };
  }

  /** Whether the part has changed enough since the last fit to fit it again. */
  private outgrown(): boolean {
    if (!this.fitted) return true;
    const now = this.sphere();
    const scale = Math.max(this.fitted.radius, 1e-9);
    return (
      Math.abs(now.radius - this.fitted.radius) / scale > REFIT_TOLERANCE ||
      now.center.distanceTo(this.fitted.center) / scale > REFIT_TOLERANCE
    );
  }

  private sphere(): THREE.Sphere {
    const sphere = this.mesh!.geometry.boundingBox!.getBoundingSphere(new THREE.Sphere());
    if (!(sphere.radius > 0)) sphere.radius = 1;
    return sphere;
  }

  /** How far away a sphere of `radius` fits the view, whichever way it's narrower. */
  private distanceFor(radius: number): number {
    const vertical = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.camera.aspect);
    return (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * FRAME_MARGIN;
  }

  private setClipping(distance: number): void {
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
  }

  private stepFly(fly: Fly): void {
    const t = Math.min((performance.now() - fly.began) / FLY_MS, 1);
    const eased = t * (2 - t);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.lerpVectors(fly.fromTarget, fly.toTarget, eased);
    const distance = THREE.MathUtils.lerp(fly.fromDistance, fly.toDistance, eased);
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.camera.lookAt(this.controls.target);
    if (t === 1) {
      this.fly = null;
      this.setClipping(fly.toDistance);
    }
  }

  /** Swings the camera round the target to look from `direction`. */
  lookFrom(direction: THREE.Vector3): void {
    // Spend whatever drag momentum is left now, so it can't nudge the camera
    // off the chosen view once the turn ends.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    const end = direction.clone().normalize();
    // OrbitControls can't look exactly along the up axis, so tilt the top and
    // bottom views a hair towards the front.
    if (Math.abs(end.y) > 0.999) end.set(0, Math.sign(end.y), 1e-3).normalize();
    const start = this.camera.position.clone().sub(this.controls.target).normalize();
    this.turn = {
      start,
      rotation: new THREE.Quaternion().setFromUnitVectors(start, end),
      began: performance.now(),
    };
  }

  private stepTurn(turn: Turn): void {
    const t = Math.min((performance.now() - turn.began) / TURN_MS, 1);
    const eased = t * (2 - t);
    const direction = turn.start
      .clone()
      .applyQuaternion(new THREE.Quaternion().slerp(turn.rotation, eased));
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.camera.lookAt(this.controls.target);
    if (t === 1) this.turn = null;
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private render(): void {
    if (this.fly) this.stepFly(this.fly);
    if (this.turn) this.stepTurn(this.turn);
    if (!this.fly && !this.turn) this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.cube.render(this.camera.quaternion);
  }
}

/**
 * A labelled cube that turns with the camera. Clicking a face, edge or
 * corner calls `onPick` with the direction to look from.
 */
class ViewCube {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-2.2, 2.2, 2.2, -2.2, 0.1, 20);
  private readonly cube: THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial[]>;
  private readonly highlight: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly listeners: [string, (event: PointerEvent) => void][];
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, onPick: (direction: THREE.Vector3) => void) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2));
    const light = new THREE.DirectionalLight(0xffffff, 1.2);
    light.position.set(0.5, 1, 1);
    this.camera.add(light);

    // BoxGeometry's face order is +x, -x, +y, -y, +z, -z.
    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      ["Right", "Left", "Top", "Bottom", "Front", "Back"].map(
        (label) => new THREE.MeshLambertMaterial({ map: faceTexture(label) }),
      ),
    );
    this.scene.add(this.cube);
    this.scene.add(
      new THREE.LineSegments(
        new THREE.EdgesGeometry(this.cube.geometry),
        new THREE.LineBasicMaterial({ color: 0x71717a }),
      ),
    );
    const corner = new THREE.Vector3(-1.08, -1.08, -1.08);
    const axes: [THREE.Vector3, number][] = [
      [new THREE.Vector3(1, 0, 0), 0xef4444],
      [new THREE.Vector3(0, 1, 0), 0x22c55e],
      [new THREE.Vector3(0, 0, 1), 0x3b82f6],
    ];
    for (const [axis, color] of axes) {
      this.scene.add(new THREE.ArrowHelper(axis, corner, 2.8, color, 0.35, 0.2));
    }

    this.highlight = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x2563eb,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.listeners = [
      ["pointermove", (event) => this.showHighlight(this.pick(event))],
      ["pointerleave", () => this.showHighlight(null)],
      [
        "click",
        (event) => {
          const region = this.pick(event);
          if (region) onPick(region);
        },
      ],
    ];
    for (const [type, listener] of this.listeners) {
      canvas.addEventListener(type, listener as EventListener);
    }
  }

  render(quaternion: THREE.Quaternion): void {
    this.camera.quaternion.copy(quaternion);
    this.camera.position.set(0, 0, 8).applyQuaternion(quaternion);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const [type, listener] of this.listeners) {
      this.canvas.removeEventListener(type, listener as EventListener);
    }
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        for (const material of [object.material].flat() as THREE.Material[]) {
          (material as THREE.MeshLambertMaterial).map?.dispose();
          material.dispose();
        }
      }
    });
    this.renderer.dispose();
  }

  /**
   * Where the pointer looks from: the face it is over, plus the neighbouring
   * face(s) near an edge or corner. (1, 0, 0) is the Right face, (1, 1, 0)
   * the top-right edge, (1, 1, 1) a corner.
   */
  private pick(event: PointerEvent): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const [hit] = this.raycaster.intersectObject(this.cube);
    if (!hit) return null;
    const [x, y, z] = hit.point.toArray().map((c) => (Math.abs(c) > 0.6 ? Math.sign(c) : 0));
    return new THREE.Vector3(x, y, z);
  }

  private showHighlight(region: THREE.Vector3 | null): void {
    this.highlight.visible = region !== null;
    this.canvas.style.cursor = region ? "pointer" : "";
    if (!region) return;
    // Faces span ±0.6 of the side; edges and corners the 0.4 beyond that.
    // Each piece sits slightly proud of the cube so it isn't hidden by it.
    const [sx, sy, sz] = region.toArray().map((r) => (r === 0 ? 1.2 : 0.44));
    this.highlight.scale.set(sx!, sy!, sz!);
    this.highlight.position.copy(region).multiplyScalar(0.82);
  }
}

function faceTexture(label: string): THREE.CanvasTexture {
  const size = 128;
  const face = document.createElement("canvas");
  face.width = face.height = size;
  const g = face.getContext("2d")!;
  g.fillStyle = "#e4e4e7";
  g.fillRect(0, 0, size, size);
  g.strokeStyle = "#a1a1aa";
  g.lineWidth = 6;
  g.strokeRect(3, 3, size - 6, size - 6);
  g.fillStyle = "#3f3f46";
  g.font = "600 28px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(label, size / 2, size / 2);
  const texture = new THREE.CanvasTexture(face);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}
