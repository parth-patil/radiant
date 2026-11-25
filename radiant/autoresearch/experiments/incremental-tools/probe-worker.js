(() => {
    const scope = self;
    const proto = Object.getPrototypeOf(scope);
    let desc = null; for (let p = scope; p && !desc; p = Object.getPrototypeOf(p)) desc = Object.getOwnPropertyDescriptor(p, 'onmessage');
    const origPost = scope.postMessage.bind(scope);
    let cur = null;
    scope.postMessage = function (msg, transfer) {
      const t0 = performance.now();
      const r = origPost(msg, transfer);
      const dt = performance.now() - t0;
      if (cur) { if (!cur.posts) { cur.p0 = performance.timeOrigin + t0; cur.p1 = performance.timeOrigin + t0 + dt; } cur.post += dt; cur.posts++; }
      return r;
    };
    Object.defineProperty(scope, 'onmessage', { configurable: true, get() { return desc.get.call(scope); }, set(fn) {
      desc.set.call(scope, fn && function (ev) {
        const t0 = performance.now();
        const data = ev.data;
        const t1 = performance.now();
        cur = { seq: data && data.sequence, kind: data ? Object.keys(data).filter(k => k !== 'sequence').join(',') : '', deser: t1 - t0, post: 0, posts: 0 };
        let wrapped = Object.create(ev, { data: { value: data } });
        try { return fn.call(this, wrapped); } finally {
          cur.handler = performance.now() - t1;
          const rec = cur; cur = null;
          origPost({ __probe: rec });
        }
      });
    }});
  })();
