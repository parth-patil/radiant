
(() => {
  const now = () => performance.now();
  const log = window.__tp = { main: [], worker: [], post: [] };
  const NativeWorker = window.Worker;
  const post = NativeWorker.prototype.postMessage;
  NativeWorker.prototype.postMessage = function (msg, transfer) {
    const t0 = now();
    const r = post.call(this, msg, transfer);
    log.post.push({ seq: msg && msg.sequence, kind: msg ? Object.keys(msg).filter(k => k !== 'sequence').join(',') : '', ms: now() - t0, at: t0 });
    return r;
  };
  const desc = Object.getOwnPropertyDescriptor(NativeWorker.prototype, 'onmessage');
  Object.defineProperty(NativeWorker.prototype, 'onmessage', { configurable: true, get() { return desc.get.call(this); }, set(fn) {
    desc.set.call(this, fn && function (ev) {
      const t0 = now();
      const data = ev.data;
      const t1 = now();
      if (data && data.__probe) { log.worker.push({ ...data.__probe, at: t0 }); return; }
      const wrapped = Object.create(ev, { data: { value: data } });
      try { return fn.call(this, wrapped); } finally {
        log.main.push({ abs: performance.timeOrigin + t0, abs1: performance.timeOrigin + t1, seq: data && data.sequence, kind: data ? Object.keys(data).filter(k => k !== 'sequence').join(',') : '', deser: t1 - t0, handler: now() - t1, at: t0 });
      }
    });
  }});
})();
