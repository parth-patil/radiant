
import json,sys
d=json.load(open(sys.argv[1]))
pat = sys.argv[2].split(',') if len(sys.argv)>2 else ['load','rebuild','edit','fold','heap','pan_cpu_mean@50k','stream_longtask','stream_block_max']
for eng, e in d['engines'].items():
    A=e['trees']['A']['medians']; B=e['trees']['B']['medians']
    print('==', eng, 'score A %.2f B %.2f' % (e['trees']['A']['scores']['score'], e['trees']['B']['scores']['score']))
    for k in sorted(A):
        if '/fit' in k or '/z' in k: continue
        if not any(k.startswith(p) for p in pat): continue
        a=A.get(k); b=B.get(k)
        if a is None or b is None: continue
        print('  %-34s %9.2f %9.2f  %.3f' % (k, a, b, (b/a if a else float('nan'))))
