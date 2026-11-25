// Page-side driver for measure.py and visual.py. Evaluated in each fresh page; talks to the app only through
// window.__radiantBench (src/lib/ui/bench-hooks.ts). Everything here returns plain JSON.
(() => {
  if (window.__benchRun) return;
  const B = () => window.__radiantBench;
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const now = () => performance.now();
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const pct = (values, p) => {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
  };
  const mean = (a) => (a.length ? sum(a) / a.length : null);

  // Wait until nothing is on its way to the screen, seen on two consecutive animation frames.
  async function untilIdle(timeout = 120000) {
    const end = now() + timeout;
    let quiet = 0;
    while (quiet < 2) {
      if (now() > end) throw new Error('page never became idle');
      await frame();
      quiet = B().idle() ? quiet + 1 : 0;
    }
  }

  // Run an action and time it to the frames that show its result.
  //   settledMs: action start to the end of the last frame drawn before the page went idle (the headline value)
  //   firstMs:   action start to the first frame drawn with the new layout (diagnostic)
  async function measure(action, { needLayout = true, timeout = 120000 } = {}) {
    await untilIdle(timeout);
    const frames = [];
    const off = B().onFrame((f) => frames.push({ t: f.t, drawMs: f.drawMs, gen: B().layoutGeneration() }));
    const gen0 = B().layoutGeneration();
    const t0 = now();
    try {
      action();
      const actionMs = now() - t0;
      const end = t0 + timeout;
      let quiet = 0;
      while (quiet < 2) {
        if (now() > end) throw new Error('timed out waiting for the result on screen');
        await frame();
        const done = frames.length > 0 && (!needLayout || B().layoutGeneration() > gen0) && B().idle();
        quiet = done ? quiet + 1 : 0;
      }
      const first = frames.find((f) => f.gen > gen0) ?? frames[0];
      const d = B().diagnostics();
      const adoptAt = typeof d.adoptAt === 'number' && d.adoptAt >= t0 ? d.adoptAt - t0 : null;
      return {
        settledMs: frames[frames.length - 1].t - t0,
        firstMs: first.t - t0,
        actionMs,
        frames: frames.length,
        drawMs: sum(frames.map((f) => f.drawMs)),
        firstDrawMs: first.drawMs,
        adoptStartMs: adoptAt,
        adoptMs: adoptAt !== null ? d.adoptMs : null,
        layoutMs: d.layoutMs, geometryMs: d.geometryMs, branchMeshMs: d.branchMeshMs,
        layoutSource: d.layoutSource, meshTriangles: d.meshTriangles
      };
    } finally {
      off();
    }
  }

  async function heapMB() {
    if (typeof window.gc === 'function') { window.gc(); await frame(); window.gc(); }
    const m = performance.memory;
    return m ? m.usedJSHeapSize / 1048576 : null;
  }

  // Pan and zoom along a fixed path; one camera change per animation frame. Script per frame = the camera change
  // (including the microtask the app's reactive UI runs in) + the main-thread draw of the frame it causes.
  async function pan(zoomSpec, { warm = 10, count = 45, gpu = true } = {}) {
    const b = B();
    let c0;
    if (zoomSpec === 'fit') {
      b.fit();
      c0 = b.camera();
    } else {
      const id = b.nodeAtDepth(2, 0.5);
      const box = id && b.box(id);
      if (!box) throw new Error('no anchor node to pan over');
      c0 = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: zoomSpec };
      b.setCamera(c0);
    }
    await untilIdle();
    const z = c0.zoom;
    const ax = 0.22 * innerWidth / z, ay = 0.14 * innerHeight / z;
    const gpuOn = gpu && b.gpuTimer(true);
    b.gpuSamples();
    const frames = [];
    const off = b.onFrame((f) => frames.push(f));
    const camera = [], intervals = [];
    const n = warm + count;
    let last = await frame();
    try {
      for (let i = 0; i < n; i++) {
        const ph = (2 * Math.PI * (i + 1)) / n;
        const s = now();
        b.setCamera({ cx: c0.cx + ax * Math.sin(ph), cy: c0.cy + ay * Math.sin(2 * ph), zoom: z * (1 + 0.08 * Math.sin(3 * ph)) });
        await Promise.resolve();
        camera.push(now() - s);
        const t = await frame();
        intervals.push(t - last);
        last = t;
      }
      await frame();
      await frame();
    } finally {
      off();
    }
    const gpuAll = gpuOn ? b.gpuSamples() : [];
    b.gpuTimer(false);
    const drawn = frames.slice(0, n);
    const script = drawn.map((f, i) => f.drawMs + (camera[i] ?? 0)).slice(warm);
    const items = drawn.slice(warm).map((f) => f.items);
    const gpuMs = gpuAll.length > warm ? gpuAll.slice(warm) : gpuAll;
    await untilIdle();
    return {
      zoom: z, framesDrawn: frames.length, framesExpected: n,
      script, items, gpu: gpuMs, intervals: intervals.slice(warm),
      scriptMean: mean(script), scriptP95: pct(script, 0.95),
      gpuMean: gpuMs.length ? mean(gpuMs) : null, gpuP95: gpuMs.length ? pct(gpuMs, 0.95) : null,
      itemsMedian: pct(items, 0.5), gpuAvailable: gpuOn
    };
  }

  // Keep panning while count nodes are added one by one (one every 'every' frames), then let it settle.
  async function stream(parent, { count = 20, every = 6, tail = 45, label = 'Streamed idea' } = {}) {
    const b = B();
    const box = b.box(parent);
    if (!box) throw new Error('stream parent is not laid out');
    const c0 = { cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 0.6 };
    b.setCamera(c0);
    await untilIdle();
    const longtasks = [];
    let observer = null;
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longtasks.push(e.duration); });
      observer.observe({ type: 'longtask' });
    }
    // Main-thread probe: a chained setTimeout(0) (clamped to about 4 ms) records how long the thread was busy
    // between turns; a gap of X ms means a task (or a frame's work) held the thread for about X ms. Works in every
    // engine, unlike the Long Tasks API (Chrome only, recorded as well).
    const gaps = [];
    let probing = true, probeLast = now();
    const tick = () => { const t = now(); gaps.push(t - probeLast); probeLast = t; if (probing) setTimeout(tick, 0); };
    setTimeout(tick, 0);
    const intervals = [];
    const n = count * every + tail;
    const nodes0 = b.nodeCount();
    let last = await frame();
    const t0 = last;
    for (let i = 0; i < n; i++) {
      if (i % every === 0 && i / every < count) b.addChild(parent, label + ' ' + (i / every + 1));
      const ph = (2 * Math.PI * (i + 1)) / n;
      b.setCamera({ cx: c0.cx + 300 * Math.sin(ph), cy: c0.cy + 160 * Math.sin(2 * ph), zoom: 0.6 * (1 + 0.1 * Math.sin(ph)) });
      const t = await frame();
      intervals.push(t - last);
      last = t;
    }
    await untilIdle();
    const doneMs = now() - t0;
    probing = false;
    if (observer) { observer.takeRecords?.().forEach((e) => longtasks.push(e.duration)); observer.disconnect(); }
    return {
      worstGapMs: Math.max(...intervals),
      over16_7: intervals.filter((v) => v > 16.7).length,
      over25: intervals.filter((v) => v > 25).length,
      over33: intervals.filter((v) => v > 33.4).length,
      frames: intervals.length, intervalP50: pct(intervals, 0.5), intervalP95: pct(intervals, 0.95),
      blockMaxMs: gaps.length ? Math.max(...gaps) : null,
      blockTotalMs: sum(gaps.map((g) => Math.max(0, g - 50))),
      busyOver16Ms: sum(gaps.map((g) => Math.max(0, g - 16.7))),
      longtaskMax: longtasks.length ? Math.max(...longtasks) : (observer ? 0 : null),
      longtaskCount: observer ? longtasks.length : null,
      addedNodes: b.nodeCount() - nodes0, doneMs
    };
  }

  window.__benchRun = {
    async ready(timeout = 60000) {
      const end = now() + timeout;
      while (!B()) {
        if (now() > end) throw new Error('window.__radiantBench never appeared: was the build made with VITE_RADIANT_BENCH=1?');
        await new Promise((r) => setTimeout(r, 25));
      }
      await untilIdle();
      let previous = await frame();
      const gaps = [];
      for (let i = 0; i < 20; i++) { const t = await frame(); gaps.push(t - previous); previous = t; }
      return { version: B().version, rafIntervalMs: pct(gaps, 0.5), dpr: devicePixelRatio, w: innerWidth, h: innerHeight,
        gpuTimer: B().gpuTimer(false), ua: navigator.userAgent };
    },
    untilIdle,
    async load(n, theme) {
      const r = await measure(() => B().loadSynthetic(n, theme));
      r.nodes = B().nodeCount();
      return r;
    },
    async loadOutline(title, root, theme) {
      return measure(() => B().loadOutline(title, root, theme));
    },
    heapMB,
    async rebuild(theme) {
      const r = await measure(() => B().setTheme(theme));
      r.gpuBufferMB = B().memory().gpuBufferBytes / 1048576;
      return r;
    },
    pan,
    async edit(times = 3) {
      const b = B();
      const parent = b.nodeAtDepth(3, 0.5);
      const box = parent && b.box(parent);
      if (!box) throw new Error('no mid-depth node');
      b.setCamera({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: 1 });
      const out = [];
      for (let i = 0; i < times; i++) out.push(await measure(() => b.addChild(parent, 'Benchmark idea ' + (i + 1))));
      return out;
    },
    async fold(times = 2, near = 300) {
      const b = B();
      const target = b.nodeWithSubtreeNear(near);
      if (!target) throw new Error('no fold target');
      b.fit();
      const out = [];
      for (let i = 0; i < times; i++) {
        const fold = await measure(() => b.toggleFold(target.id));
        const unfold = await measure(() => b.toggleFold(target.id));
        out.push({ descendants: target.descendants, fold, unfold, totalMs: fold.settledMs + unfold.settledMs });
      }
      return out;
    },
    async stream(opts) {
      const parent = B().nodeAtDepth(3, 0.25);
      return stream(parent, opts);
    },
    shape: () => B().shape(),
    // visual.py: position the camera
    async view(spec) {
      const b = B();
      if (spec.kind === 'fit') b.fit();
      else {
        const id = b.nodeAtDepth(spec.depth ?? 1, spec.fraction ?? 0);
        const box = id && b.box(id);
        if (!box) throw new Error('no node to centre on');
        b.setCamera({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, zoom: spec.zoom });
      }
      await untilIdle();
      await frame();
      await frame();
      return b.camera();
    },
    async setDark(dark) { B().setDark(dark); await untilIdle(); },
  };
})();
