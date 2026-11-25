// Imported only by the isolated performance fixtures.
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

export function distribution(samples) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw Error('Missing or invalid timing sample');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { mean: samples.reduce((sum, n) => sum + n, 0) / samples.length,
    p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
}

export async function panReference(c, scenario, slowdownMs = 0) {
  const { renderer, pipeline, camera } = c;
  if (document.visibilityState !== 'visible' || pipeline.doc !== c.doc || pipeline.nodeCount !== scenario.nodes) {
    throw Error('The reference map must be open and visible');
  }
  const pictures = Object.values(c.doc.nodes).filter(node => node.imageAsset);
  if (pictures.length !== scenario.pictures) throw Error('Reference picture count changed');
  const focus = pictures[Math.floor(pictures.length / 2)] ?? c.doc.nodes[c.doc.roots[0]];
  const box = pipeline.box(focus.id);
  if (!box) throw Error('Reference landmark is missing');
  camera.set({ cx: box.x, cy: box.y, zoom: .7 });
  if (pictures.length) await c.ensureImage(focus.imageAsset);
  let previous = await frame();
  const refresh = [];
  for (let i = 0; i < 60; i++) {
    const stamp = await frame();
    refresh.push(stamp - previous);
    previous = stamp;
  }
  const refreshInterval = distribution(refresh).p50;
  const interval = [], renderTime = [], visibleSet = [];
  const render = renderer.render;
  const gl = document.querySelector('canvas.map').getContext('webgl2');
  const timer = gl?.getExtension('EXT_disjoint_timer_query_webgl2');
  const queries = [], gpuTime = [];
  function collectGpu() {
    if (!queries.length) return;
    if (gl.getParameter(timer.GPU_DISJOINT_EXT)) {
      for (const q of queries.splice(0)) gl.deleteQuery(q);
      return;
    }
    while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = queries.shift();
      gpuTime.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  }
  let picturesDrawn = 0;
  let pendingCameraMs = 0;
  renderer.render = function () {
    collectGpu();
    const query = timer && renderTime.length % 12 === 0 ? gl.createQuery() : null;
    const start = performance.now();
    if (slowdownMs) {
      while (performance.now() - start < slowdownMs) { /* intentional regression in the draw path */ }
    }
    if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    try {
      render.call(this);
    } finally {
      if (query) { gl.endQuery(timer.TIME_ELAPSED_EXT); queries.push(query); }
    }
    renderTime.push(performance.now() - start + pendingCameraMs);
    pendingCameraMs = 0;
    visibleSet.push(this.stats.visibleSetMs);
    picturesDrawn = Math.max(picturesDrawn, this.stats.imagesDrawn);
  };
  try {
    // The path depends on elapsed time so a slower display traverses the same map.
    const begin = await frame();
    previous = begin;
    do {
      const angle = 2 * Math.PI * (previous - begin) / 10000;
      const update = performance.now();
      camera.set({ cx: box.x + 850 * Math.sin(angle), cy: box.y + 400 * Math.sin(2 * angle),
        zoom: .50 + .20 * Math.cos(angle) });
      await Promise.resolve(); // include the reactive UI update scheduled by the camera change
      pendingCameraMs += performance.now() - update;
      const stamp = await frame();
      interval.push(stamp - previous);
      previous = stamp;
    } while (previous - begin < 10000);
  } finally {
    renderer.render = render;
    collectGpu();
    for (const query of queries) gl.deleteQuery(query);
  }
  if (document.visibilityState !== 'visible' || !renderTime.length ||
      (pictures.length && !picturesDrawn)) throw Error('Reference pan did not draw the requested content');
  const timings = distribution(interval);
  const result = { interval: timings, script: distribution(renderTime), visibleSet: distribution(visibleSet),
    intervalSamples: interval, scriptSamples: renderTime, refreshInterval, picturesDrawn,
    missedDraws: Math.max(0, interval.length - renderTime.length),
    gpuTimerAvailable: Boolean(timer), gpuSamples: gpuTime, gpu: gpuTime.length ? distribution(gpuTime) : null,
    longIntervals: interval.filter(ms => ms > 1.5 * timings.mean).length };
  if (scenario.name === 'large') {
    // Exclude deferred texture uploads before starting the specified ten-second idle observation.
    let since = performance.now(), frames = renderer.stats.frames;
    const deadline = since + 12000;
    while (performance.now() - since < 500) {
      if (performance.now() > deadline) throw Error('Map never settled after pan');
      await frame();
      if (renderer.stats.frames !== frames) { frames = renderer.stats.frames; since = performance.now(); }
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
    result.idleDraws = renderer.stats.frames - frames;
  }
  return result;
}
