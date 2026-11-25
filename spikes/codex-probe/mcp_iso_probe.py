#!/usr/bin/env python3
"""No-model-call test: which override disables user MCP servers. usage: mcp_iso_probe.py <variant>"""
import json,subprocess,sys,time,os,select
v=sys.argv[1]
base=["codex","app-server","--listen","stdio://"]
tp={"cwd":os.getcwd(),"approvalPolicy":"never","sandbox":"read-only","ephemeral":True}
if v=="enabled_false": base+=["-c","mcp_servers.context7.enabled=false","-c","mcp_servers.node_repl.enabled=false","-c","mcp_servers.clickup.enabled=false"]
if v=="empty_table": base+=["-c","mcp_servers={}"]
if v=="thread_config": tp["config"]={"mcp_servers":{}}
if v=="thread_config_dotted": tp["config"]={"mcp_servers.context7.enabled":False,"mcp_servers.node_repl.enabled":False,"mcp_servers.clickup.enabled":False}
if v=="plugins_off": base+=["--disable","plugins","--disable","apps"]
if v=="all_off": base+=["--disable","plugins","--disable","apps","--disable","computer_use","--disable","browser_use","--disable","browser_use_external","--disable","in_app_browser"]; tp["config"]={"mcp_servers.context7.enabled":False,"mcp_servers.node_repl.enabled":False,"mcp_servers.clickup.enabled":False}
p=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
def s(m): p.stdin.write(json.dumps(m)+"\n"); p.stdin.flush()
s({"method":"initialize","id":1,"params":{"clientInfo":{"name":"mm_probe","title":None,"version":"0"},"capabilities":{"experimentalApi":False,"requestAttestation":False}}})
s({"method":"initialized"}); s({"method":"thread/start","id":2,"params":tp})
end=time.time()+5; names=set()
while time.time()<end:
    r,_,_=select.select([p.stdout],[],[],0.5)
    if not r: continue
    m=json.loads(p.stdout.readline())
    if m.get("method")=="mcpServer/startupStatus/updated": names.add((m["params"]["name"],m["params"]["status"]))
    if m.get("id")==2 and "error" in m: print("err",json.dumps(m)[:300])
print(v,sorted(names))
p.stdin.close(); p.terminate()
