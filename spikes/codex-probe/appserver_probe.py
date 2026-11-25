#!/usr/bin/env python3
"""Minimal codex app-server stdio client. stdlib only.
usage: appserver_probe.py LOG.jsonl PROMPT [--schema FILE] [--effort low] [--model M]
       [--sandbox read-only|workspace-write] [--interrupt-after-ms N] [--second-prompt P]
       [--binary CODEX]
Logs every line (both directions) with ms timestamps to LOG.jsonl.
"""
import json, subprocess, sys, time, threading, os, argparse, queue

ap = argparse.ArgumentParser()
ap.add_argument("log"); ap.add_argument("prompt")
ap.add_argument("--schema"); ap.add_argument("--effort", default="low")
ap.add_argument("--model", default="gpt-6-luna")
ap.add_argument("--sandbox", default="read-only")
ap.add_argument("--interrupt-after-ms", type=int)
ap.add_argument("--second-prompt"); ap.add_argument("--ref-image")
ap.add_argument("--timeout", type=int, default=170)
ap.add_argument("--binary", default="codex")
a = ap.parse_args()

SCR = os.path.dirname(os.path.abspath(__file__))
DISABLE = ["apps", "plugins", "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external",
           "computer_use", "in_app_browser", "goals", "memories", "hooks"]
if a.sandbox == "read-only":  # image generation needs the tool
    DISABLE += ["image_generation", "view_image"]
cmd = [a.binary, "app-server", "--listen", "stdio://", "-c", "web_search=disabled"]
for f in DISABLE: cmd += ["--disable", f]
t0 = time.monotonic()
def ms(): return int((time.monotonic() - t0) * 1000)
logf = open(a.log, "w")
def log(d, dr, received_at=None):
    logf.write(json.dumps({"t_ms": ms() if received_at is None else received_at, "dir": dr, "msg": d}) + "\n"); logf.flush()

p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(a.log + ".stderr", "w"),
                     text=True, bufsize=1, cwd=SCR)
q = queue.Queue()
def reader():
    for line in p.stdout:
        t = ms(); q.put((t, line))
    q.put((ms(), None))
threading.Thread(target=reader, daemon=True).start()
nid = 0
def send(method, params=None, notif=False):
    global nid
    m = {"method": method}
    if params is not None: m["params"] = params
    if not notif:
        nid += 1; m["id"] = nid
    log(m, "out"); p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
    return nid
def reply(id_, result):
    m = {"id": id_, "result": result}; log(m, "out"); p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()

pending = {}
def pump(until_id=None, until_method=None, deadline=None):
    """read messages until response id or notification method arrives"""
    while True:
        rem = deadline - time.time() if deadline else 30
        if rem <= 0: return None
        try: t, line = q.get(timeout=min(rem, 1))
        except queue.Empty: continue
        if line is None: return None
        m = json.loads(line); log(m, "in", t)
        if "method" in m and "id" in m:  # server request: decline
            reply(m["id"], {"decision": "decline"}); continue
        if "id" in m and m["id"] == until_id: return m
        if m.get("method") == until_method: return m
def yield_check(): pass

deadline = time.time() + a.timeout
send("initialize", {"clientInfo": {"name": "mm_probe", "title": "MM probe", "version": "0.0.1"},
                    "capabilities": {"experimentalApi": False, "requestAttestation": False}})
r = pump(until_id=nid, deadline=deadline); print("init:", json.dumps(r)[:300])
send("initialized", None, notif=True)
tp = {"cwd": SCR, "approvalPolicy": "never", "sandbox": a.sandbox, "model": a.model,
      "ephemeral": True, "serviceName": "mm_probe",
      "config": {"mcp_servers.context7.enabled": False, "mcp_servers.node_repl.enabled": False, "mcp_servers.clickup.enabled": False}}
i = send("thread/start", tp)
r = pump(until_id=i, deadline=deadline); tid = r["result"]["thread"]["id"]; print("thread:", tid)

def run_turn(prompt, schema=None, interrupt_ms=None):
    params = {"threadId": tid, "input": [{"type": "text", "text": prompt, "text_elements": []}],
              "effort": a.effort}
    if a.ref_image: params["input"].append({"type": "localImage", "path": os.path.abspath(a.ref_image)})
    if schema: params["outputSchema"] = json.load(open(schema))
    ts = ms()
    i = send("turn/start", params)
    turn_id = None; first_delta = None; deltas = []; intr_sent = False
    while time.time() < deadline:
        try: t, line = q.get(timeout=0.2)
        except queue.Empty:
            if interrupt_ms and turn_id and not intr_sent and ms() - ts > interrupt_ms:
                send("turn/interrupt", {"threadId": tid, "turnId": turn_id}); intr_sent = True
            continue
        if line is None: break
        m = json.loads(line); log(m, "in", t)
        if "method" in m and "id" in m: reply(m["id"], {"decision": "decline"}); continue
        if m.get("id") == i and "result" in m: turn_id = m["result"]["turn"]["id"]
        meth = m.get("method")
        if meth == "item/agentMessage/delta":
            if first_delta is None: first_delta = t - ts
            deltas.append((t - ts, len(m["params"]["delta"])))
        if interrupt_ms and turn_id and not intr_sent and ms() - ts > interrupt_ms:
            send("turn/interrupt", {"threadId": tid, "turnId": turn_id}); intr_sent = True
        if meth == "turn/completed":
            print("turn status:", m["params"]["turn"]["status"], "total_ms:", t - ts,
                  "first_delta_ms:", first_delta, "n_deltas:", len(deltas))
            print("delta cadence (t_ms,len):", deltas[:12], "...", deltas[-3:])
            return m
    print("TIMEOUT"); return None

try:
    send("account/rateLimits/read", {});
    run_turn(a.prompt, a.schema, a.interrupt_after_ms)
    if a.second_prompt: run_turn(a.second_prompt, None)
    i = send("account/rateLimits/read", None)
    t_end = time.time() + 5
    while time.time() < t_end:
        try: t, line = q.get(timeout=0.5)
        except queue.Empty: continue
        if line is None: break
        log(json.loads(line), "in", t)
finally:
    try: p.stdin.close()
    except Exception: pass
    try: p.wait(timeout=5)
    except Exception: p.kill()
print("done")
