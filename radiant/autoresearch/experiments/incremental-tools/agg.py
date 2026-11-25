import sys, json, collections
d = json.load(open(sys.argv[1])); prof = d["profile"]; edits = len(d["times"])
nodes = {nd["id"]: nd for nd in prof["nodes"]}
parent = {}
for nd in prof["nodes"]:
    for c in nd.get("children", []): parent[c] = nd["id"]
def name(nid):
    cf = nodes[nid]["callFrame"]; return f'{cf["functionName"] or "(anon)"} {cf["url"].split("/")[-1].split("?")[0]}:{cf["lineNumber"]+1}'
t = prof["startTime"]; times = []
for dlt in prof["timeDeltas"]: t += dlt; times.append(t)
def stack(nid):
    out = []
    while nid is not None and nid in nodes:
        out.append(nid); nid = parent.get(nid)
    return out
inCW = [i for i, s in enumerate(prof["samples"]) if any(nodes[x]["callFrame"]["functionName"] == "computeWork" for x in stack(s))]
# the cold pass ends before a >200 ms gap
start = None
for a, b in zip(inCW, inCW[1:]):
    if times[b] - times[a] > 200000: start = b
keep = [i for i in inCW if i >= start]
dt = lambda i: (times[i+1] - times[i]) if i + 1 < len(times) else 0
gc = sum(dt(i) for i in range(start, keep[-1] + 1) if nodes[prof["samples"][i]]["callFrame"]["functionName"] == "(garbage collector)")
allw = sum(dt(i) for i in range(start, keep[-1] + 1))
print("edits", edits, "window ms/edit", round(allw/1000/edits, 1), "computeWork ms/edit", round(sum(dt(i) for i in keep)/1000/edits, 1), "gc ms/edit", round(gc/1000/edits, 1))
selfc = collections.Counter(); incl = collections.Counter()
for i in keep:
    st = stack(prof["samples"][i]); w = dt(i) / 1000
    selfc[name(st[0])] += w
    seen = set()
    for x in st:
        nm = name(x)
        if nm not in seen: incl[nm] += w; seen.add(nm)
print("--- self ms per edit")
for k, v in selfc.most_common(int(sys.argv[2]) if len(sys.argv) > 2 else 40): print(f"{v/edits:7.2f}  {k}")
print("--- inclusive ms per edit")
for k, v in incl.most_common(int(sys.argv[3]) if len(sys.argv) > 3 else 45): print(f"{v/edits:7.2f}  {k}")
