import type { CameraState, Scene } from '../core/types';

/** Backend boundary for world-space meshes, rectangle and texture quads, text, and camera uniforms. */
export interface RenderDevice {
  invalidateImageSource?(url: string): void;
  setScene(scene: Scene): void;
  setCamera(camera: CameraState): void;
  render(): void;
  destroy(): void;
}
