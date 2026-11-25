#!/usr/bin/env python3
"""Mechanical contract check. usage: check_svg.py file.svg  (stdlib only)"""
import sys, re, xml.etree.ElementTree as ET
BOX={"n1":(300,240,200,120),"n2":(40,40,220,140),"n3":(540,40,220,140),"n4":(40,420,220,140),"n5":(540,420,220,140)}
PAL={"#3b2417","#8b5a2b","#d9a066","#f2e3c6","#e4572e"}
raw=open(sys.argv[1]).read(); print("bytes",len(raw.encode()))
try: root=ET.fromstring(raw)
except Exception as e: print("NOT WELL-FORMED",e); sys.exit(1)
print("well-formed: yes")
ns=lambda t:t.split('}')[-1]
els=list(root.iter()); from collections import Counter
print("elements",dict(Counter(ns(e.tag) for e in els)))
print("viewBox",root.get("viewBox"))
bad={"script","text","image","foreignObject"}
print("forbidden present:",sorted({ns(e.tag) for e in els if ns(e.tag) in bad}))
print("external refs:",[v for e in els for k,v in e.attrib.items() if ns(k)=="href" and not v.startswith("#")])
cols=set(c.lower() for c in re.findall(r"#[0-9a-fA-F]{3,6}\b",raw)); print("colours used",sorted(cols),"outside palette:",sorted(cols-PAL))
print("named/rgb colours:",re.findall(r'(?:fill|stroke)="(?!#|none|url)([^"]+)"',raw))
print("path count",sum(1 for e in els if ns(e.tag)=="path"))
def pts_path(d):
    toks=re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?",d); i=0;x=y=sx=sy=0;cmd=None;pts=[]
    nargs={"M":2,"L":2,"H":1,"V":1,"C":6,"S":4,"Q":4,"T":2,"A":7,"Z":0}
    while i<len(toks):
        if re.match(r"[A-Za-z]",toks[i]): cmd=toks[i]; i+=1
        if cmd in "Zz": x,y=sx,sy; continue
        n=nargs[cmd.upper()]; a=[float(t) for t in toks[i:i+n]]; i+=n
        if len(a)<n: break
        rel=cmd.islower(); C=cmd.upper()
        if C=="H": x=a[0]+(x if rel else 0); pts.append((x,y)); continue
        if C=="V": y=a[0]+(y if rel else 0); pts.append((x,y)); continue
        for j in range(0,n-1 if C!="A" else 0,2):  # control points + end
            px=a[j]+(x if rel else 0); py=a[j+1]+(y if rel else 0); pts.append((px,py))
        if C=="A": px=a[5]+(x if rel else 0); py=a[6]+(y if rel else 0); pts.append((px,py))
        ex,ey=pts[-1]; x,y=ex,ey
        if C=="M": sx,sy=x,y; cmd="l" if rel else "L"
    return pts
def bbox(g):
    P=[]
    for e in g.iter():
        t=ns(e.tag); f=lambda k:float(e.get(k,0))
        if t=="path": P+=pts_path(e.get("d",""))
        elif t=="rect": P+=[(f("x"),f("y")),(f("x")+f("width"),f("y")+f("height"))]
        elif t=="circle": P+=[(f("cx")-f("r"),f("cy")-f("r")),(f("cx")+f("r"),f("cy")+f("r"))]
        elif t=="ellipse": P+=[(f("cx")-f("rx"),f("cy")-f("ry")),(f("cx")+f("rx"),f("cy")+f("ry"))]
        elif t=="line": P+=[(f("x1"),f("y1")),(f("x2"),f("y2"))]
        elif t in("polygon","polyline"):
            n=[float(v) for v in re.findall(r"-?\d*\.?\d+",e.get("points",""))]; P+=list(zip(n[::2],n[1::2]))
    if "transform" in raw and any(e.get("transform") for e in g.iter()): print("  (note: transforms present, bbox ignores them)")
    return (min(p[0] for p in P),min(p[1] for p in P),max(p[0] for p in P),max(p[1] for p in P)) if P else None
groups={g.get("id"):g for g in els if ns(g.tag)=="g"}
for nid,(bx,by,bw,bh) in BOX.items():
    g=groups.get("node-"+nid)
    if g is None: print(nid,"MISSING group"); continue
    ai,ao=g.get("data-anchor-in"),g.get("data-anchor-out")
    ok=lambda a:a and re.fullmatch(r"-?\d+(\.\d+)?,-?\d+(\.\d+)?",a)
    bb=bbox(g); inside=bb and bb[0]>=bx-1 and bb[1]>=by-1 and bb[2]<=bx+bw+1 and bb[3]<=by+bh+1
    def ain(a):
        if not ok(a): return None
        ax,ay=map(float,a.split(",")); return bx-1<=ax<=bx+bw+1 and by-1<=ay<=by+bh+1
    print(nid,"anchor-in",ai,"valid",bool(ok(ai)),"in-box",ain(ai),"| anchor-out",ao,"valid",bool(ok(ao)),"in-box",ain(ao),"| bbox",[round(v) for v in bb] if bb else None,"target",(bx,by,bx+bw,by+bh),"WITHIN" if inside else "OUTSIDE","| paths",sum(1 for e in g.iter() if ns(e.tag)=="path"),"elements",sum(1 for _ in g.iter()))
