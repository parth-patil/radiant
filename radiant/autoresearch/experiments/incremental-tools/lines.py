import sys, json, collections
d = json.load(open(sys.argv[1])); prof = d["profile"]; edits = len(d["times"])
fn = sys.argv[2]
interval = (prof["endTime"] - prof["startTime"]) / max(1, len(prof["samples"])) / 1000
c = collections.Counter()
for nd in prof["nodes"]:
    if nd["callFrame"]["functionName"] == fn:
        for pt in nd.get("positionTicks", []): c[pt["line"]] += pt["ticks"]
tot = sum(c.values())
print(fn, "ticks", tot, "approx ms/edit", round(tot * interval / edits, 1))
for line, t in sorted(c.items(), key=lambda x: -x[1])[:int(sys.argv[3]) if len(sys.argv) > 3 else 25]: print(line, t)
