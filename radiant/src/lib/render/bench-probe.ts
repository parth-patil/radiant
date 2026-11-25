/**
 * Benchmark-only GPU probes, used by ui/bench-hooks.ts (installed only in VITE_RADIANT_BENCH builds):
 * GPU time per frame from EXT_disjoint_timer_query_webgl2 where the platform exposes it, and the bytes held in
 * WebGL buffers allocated after the probe was created.
 */
export interface GpuProbe {
  /** Bracket one frame's GL commands. */
  beginFrame(): void;
  endFrame(): void;
  /** Turn per-frame GPU timing on or off; returns whether the platform can time the GPU at all. */
  timer(on: boolean): boolean;
  /** Drain GPU frame times (ms) whose results have arrived. */
  samples(): number[];
  bufferBytes(): number;
}

export function createGpuProbe(canvas: HTMLCanvasElement): GpuProbe {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
    { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  let timing = false;
  let active: WebGLQuery | null = null;
  const queries: WebGLQuery[] = [];
  let done: number[] = [];
  const collect = () => {
    if (!ext || !queries.length) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of queries.splice(0)) gl.deleteQuery(q);
      return;
    }
    while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = queries.shift()!;
      done.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
  };

  // Buffer accounting: remember the size given to every bufferData call, per buffer object.
  const sizes = new Map<WebGLBuffer, number>();
  const bindingOf = (target: number) => target === gl.ELEMENT_ARRAY_BUFFER ? gl.ELEMENT_ARRAY_BUFFER_BINDING
    : target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : 0;
  const bufferData = gl.bufferData;
  gl.bufferData = function (this: WebGL2RenderingContext, target: number, data: unknown, ...rest: unknown[]) {
    const binding = bindingOf(target);
    const buffer = binding ? gl.getParameter(binding) as WebGLBuffer | null : null;
    if (buffer) sizes.set(buffer, typeof data === 'number' ? data : (data as ArrayBufferView | null)?.byteLength ?? 0);
    return (bufferData as (...args: unknown[]) => void).call(this, target, data, ...rest);
  } as typeof gl.bufferData;
  const deleteBuffer = gl.deleteBuffer;
  gl.deleteBuffer = function (this: WebGL2RenderingContext, buffer: WebGLBuffer | null) {
    if (buffer) sizes.delete(buffer);
    return deleteBuffer.call(this, buffer);
  };

  return {
    beginFrame() {
      if (!timing || !ext) return;
      collect();
      if (queries.length >= 32) return;
      active = gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    endFrame() {
      if (!active || !ext) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      queries.push(active);
      active = null;
    },
    timer(on) {
      timing = on && !!ext;
      if (!timing) {
        for (const q of queries.splice(0)) gl.deleteQuery(q);
        done = [];
      }
      return !!ext;
    },
    samples() {
      collect();
      const out = done;
      done = [];
      return out;
    },
    bufferBytes() {
      let bytes = 0;
      for (const v of sizes.values()) bytes += v;
      return bytes;
    }
  };
}
