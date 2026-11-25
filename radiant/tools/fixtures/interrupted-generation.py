#!/usr/bin/env python3
"""Offline stdio peer for the native interruption gate. Leaves its map turn open."""
import json
import sys
import time


def send(message):
    print(json.dumps(message), flush=True)


if sys.argv[1:] == ['--version']:
    print('codex-cli 0.167.0')
    sys.exit(0)
if sys.argv[1:] == ['login', 'status']:
    sys.exit(0)
if sys.argv[1:] == ['app-server', '--help']:
    print('--listen --config --disable')
    sys.exit(0)
if sys.argv[1:2] != ['app-server']:
    sys.exit(1)

thread, turn = 'fixture-thread', 'fixture-turn'
responses = {
    'initialize': {'userAgent': 'radiant-test-fixture'},
    'config/read': {'config': {}},
    'model/list': {'data': []},
    'account/read': {'requiresOpenaiAuth': False},
    'thread/start': {'thread': {'id': thread, 'model': 'offline-fixture'}},
    'turn/start': {'turn': {'id': turn}},
}
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    send({'id': request['id'], 'result': responses.get(method, {})})
    if method == 'turn/start':
        for i in range(6):
            time.sleep(.25)
            node = {'id': str(i), 'parent': '0' if i else None, 'title': f'Fixture topic {i}'}
            send({'method': 'item/agentMessage/delta', 'params': {
                'threadId': thread, 'turnId': turn, 'delta': json.dumps(node) + '\n'}})
