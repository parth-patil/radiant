"""Run from the repository root with browser-use and a local Vite server."""
import json
import os
from pathlib import Path
import time

base = Path.cwd()
fixture = base / 'radiant/tools/ai-cancellation-fixture.js'
source = fixture.read_text().replace(
    "import { ReplayProvider } from '../src/lib/host/replay';",
    "const { ReplayProvider } = await import('/src/lib/host/replay.ts');"
).replace(
    "import { createDoc } from '../src/lib/core/model';",
    "const { createDoc } = await import('/src/lib/core/model/index.ts');"
).replace('export async function run', 'async function run')
frames = []
for raw in (base / 'spikes/codex-probe/logs/as3.jsonl').read_text().splitlines():
    row = json.loads(raw)
    message = row['msg']
    method = message.get('method')
    if method not in ('turn/start', 'item/agentMessage/delta', 'turn/completed'):
        continue
    payload = {'method': method}
    if method == 'item/agentMessage/delta':
        payload['params'] = {'delta': message['params']['delta']}
    if method == 'turn/completed':
        turn = message['params']['turn']
        payload['params'] = {'turn': {'status': turn['status'], 'items': turn['items']}}
    frames.append(json.dumps({'t_ms': row['t_ms'], 'dir': row['dir'], 'msg': payload}, separators=(',', ':')))
wire = json.dumps('\n'.join(frames))
new_tab(os.environ.get('RADIANT_BROWSER_URL', 'http://127.0.0.1:1420/') + '?inspector=1')
wait_for_load()
code = '(async()=>{' + source + '''
while(!window.__radiant?.c.ready)await new Promise(r=>setTimeout(r,30));
window.cancelReport=await run(window.__radiant.c, ''' + wire + ''');
})().catch(e=>window.cancelReport={error:e.stack})'''
result = cdp('Runtime.evaluate', expression=code, awaitPromise=False)
if 'exceptionDetails' in result:
    raise RuntimeError(result)
for _ in range(200):
    report = js('window.cancelReport')
    if report:
        if 'error' in report:
            raise RuntimeError(report['error'])
        print(json.dumps(report, indent=2))
        break
    time.sleep(.15)
else:
    raise RuntimeError('Timed out running cancellation replay')
