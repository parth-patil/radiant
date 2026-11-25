import type { CameraState, Mesh, Scene } from '../core/types';
import { INSTANCE_QUADS } from '../core/geometry/branch-instances';
import type { RenderDevice } from './device';
import { SceneViewport, visibleBranchSpans, type FrameBounds } from './scene-viewport';

function triangles(mesh: Mesh | undefined, bounds: FrameBounds): number {
  if (!mesh) return 0;
  const visible = visibleBranchSpans(mesh, bounds);
  // GPU-expanded branches: ends count chunk instances of INSTANCE_QUADS quads (two triangles each).
  const per = mesh.instances ? 2 * INSTANCE_QUADS : 1 / 3;
  const ends = mesh.branchSpans?.ends;
  if (!visible || !ends) return mesh.instances ? (ends?.[ends.length - 1] ?? 0) * per : mesh.indices.length / 3;
  let count = 0;
  for (const i of visible) count += ends[i] - (ends[i - 1] ?? 0);
  return count * per;
}

/** Inspect scene submission without creating a browser canvas or a GPU context. */
export class HeadlessRenderer implements RenderDevice {
  private readonly viewport = new SceneViewport();
  private scene: Scene | null = null;
  private camera: CameraState = { cx: 0, cy: 0, zoom: 1 };
  frame: {
    rects: Uint32Array;
    images: Uint32Array;
    labels: Uint32Array;
    meshTriangles: number;
    overlayTriangles: number;
    /** Canvas elements under the maps (drawn after the surface, before rects) and over them (after labels). */
    canvasBackTriangles: number;
    canvasFrontTriangles: number;
  } | null = null;

  constructor(private readonly width: number, private readonly height: number, private readonly margin = 48) {}

  setScene(scene: Scene): void {
    this.scene = scene;
    this.viewport.update(scene);
  }

  setCamera(camera: CameraState): void {
    this.camera = { ...camera };
  }

  render(): void {
    const scene = this.scene;
    if (!scene) return;
    const { bounds, rects, images, labels } = this.viewport.query(this.camera, this.width, this.height, this.margin);
    this.frame = {
      rects: rects.slice(), images: images.slice(), labels: labels.slice(),
      meshTriangles: triangles(scene.branches, bounds) + triangles(scene.animatedBranches, bounds),
      overlayTriangles: (scene.overlayMesh?.indices.length ?? 0) / 3,
      canvasBackTriangles: triangles(scene.canvasBack, bounds),
      canvasFrontTriangles: triangles(scene.canvasFront, bounds)
    };
  }

  destroy(): void {
    this.scene = null;
    this.frame = null;
  }
}
