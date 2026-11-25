#!/usr/bin/env python3
"""Replay captured JSON-RPC through Radiant's desktop transport without a login or network call."""
import argparse
import base64
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parent.parent
LOGS = PROJECT.parent / 'spikes/codex-probe/logs'
RECORDINGS = {'text': 'as1', 'schema': 'as2', 'cancel': 'as3', 'svg': 'svg1'}
FAILURES = {
    'overload': ('serverOverloaded', 'transient', 2),
    'connection': ({'responseStreamConnectionFailed': {'httpStatusCode': 503}}, 'transient', 2),
    'disconnected': ('responseStreamDisconnected', 'stream_interrupted', 1),
    'rate': ('rateLimitExceeded', 'rate_limited', 1),
    'usage': ('usageLimitExceeded', 'usage_exhausted', 1),
    'credits': ('usageLimitExceeded', 'credits_depleted', 1),
    'auth': ('unauthorized', 'not_logged_in', 1),
    'unknown': ('unknown', 'other', 1),
}


def send(message):
    print(json.dumps(message), flush=True)


def recording(name):
    directory = Path(os.environ.get('RADIANT_WIRE_RECORDINGS_DIR', LOGS))
    return [json.loads(line) for line in (directory / (name + '.jsonl')).read_text().splitlines()]


def replay_frames(case):
    rows = recording(RECORDINGS[case])
    sent = next(row for row in rows if row['dir'] == 'out' and row['msg'].get('method') == 'turn/start')
    assert ('outputSchema' in sent['msg']['params']) == (case == 'schema')
    frames = [row for row in rows if row['dir'] == 'in' and row['t_ms'] >= sent['t_ms']
              and row['msg'].get('method') in ('item/agentMessage/delta', 'turn/completed')]
    assert frames and frames[-1]['msg']['method'] == 'turn/completed'
    return frames


def serve(case, args):
    if args == ['--version']:
        print('codex-cli 0.167.0')
        return
    if args == ['login', 'status']:
        return
    if args == ['app-server', '--help']:
        print('--listen --config --disable')
        return
    if args[:1] != ['app-server']:
        raise SystemExit(2)

    count = turns = 0
    initialized = False
    frames = replay_frames(case) if case in RECORDINGS else []
    audit = Path(os.environ['RADIANT_AI_SELFTEST_DIR']) / 'peer.jsonl'
    for line in sys.stdin:
        req = json.loads(line)
        method, params = req['method'], req.get('params', {})
        if 'id' not in req:
            assert method == 'initialized' and 'params' not in req
            initialized = True
            continue
        with audit.open('a') as stream:
            stream.write(json.dumps({'method': method, 'schema': 'outputSchema' in params}) + '\n')
        result = {}
        if method == 'initialize':
            assert params['clientInfo']['name'] == 'radiant'
            assert params['capabilities'] == {'experimentalApi': False, 'requestAttestation': False}
            result = {'userAgent': 'Radiant recorded protocol fixture'}
        if method == 'config/read':
            assert initialized and params == {'includeLayers': False}
            result = {'config': {'mcp_servers': {'fixture': {}}}}
        if method == 'model/list':
            assert params == {'limit': 100}
            result = {'data': []}
        if method == 'account/read':
            assert params == {'refreshToken': False}
            result = {'requiresOpenaiAuth': False}
        if method == 'account/rateLimits/read':
            assert params == {}
            result = {'rateLimits': {'primary': {'usedPercent': 17}}}
            if case == 'quota-preflight':
                result['rateLimits']['rateLimitReachedType'] = 'workspace_member_credits_depleted'
        if method == 'thread/start':
            assert params['approvalPolicy'] == 'never' and params['sandbox'] == 'read-only'
            assert params['ephemeral'] is True and params['serviceName'] == 'radiant'
            assert params['config']['mcp_servers.fixture.enabled'] is False
            count += 1
            result = {'thread': {'id': f'thread-{count}'}}
        if method == 'turn/start':
            entry = params['input'][0]
            assert entry['type'] == 'text' and isinstance(entry['text'], str) and entry['text_elements'] == []
            assert ('outputSchema' in params) == (case == 'schema')
            turns += 1
            thread, turn = params['threadId'], f'turn-{turns}'
            result = {'turn': {'id': turn}} if case != 'turn-drift' else {'turn': {'renamedId': turn}}
        send({'id': req['id'], 'result': result})

        def notify(method, **params):
            send({'method': method, 'params': {'threadId': thread, **params}})

        if method == 'turn/interrupt' and case == 'cancel':
            assert params == {'threadId': thread, 'turnId': turn}
            terminal = frames[-1]['msg']['params']['turn']
            assert terminal['status'] == 'interrupted' and terminal['items'] == []
            notify('turn/completed', turn={**terminal, 'id': turn})
        if method != 'turn/start' or case == 'turn-drift':
            continue
        if frames:
            notify('item/agentMessage/delta', turnId='stale', delta='stale fixture delta')
            previous = frames[0]['t_ms']
            for frame in frames:
                message = frame['msg']
                if case == 'cancel' and message['method'] == 'turn/completed':
                    break
                time.sleep(max(0, frame['t_ms'] - previous) * 0.00002)
                previous = frame['t_ms']
                data = {key: value for key, value in message['params'].items() if key != 'threadId'}
                if 'turnId' in data:
                    data['turnId'] = turn
                if 'turn' in data:
                    data['turn'] = {**data['turn'], 'id': turn}
                notify(message['method'], **data)
        elif case in ('image', 'image-path'):
            png = PROJECT / 'src-tauri/icons/128x128.png'
            image = {'result': base64.b64encode(png.read_bytes()).decode()} if case == 'image' else {'savedPath': str(png)}
            notify('item/completed', turnId=turn, item={'type': 'imageGeneration', **image})
            notify('turn/completed', turn={'id': turn, 'status': 'completed'})
        elif case == 'notification-drift':
            notify('turn/completed', turn={'id': turn, 'status': True})
        elif case == 'usage-events':
            notify('account/rateLimits/updated', rateLimits={'primary': {'usedPercent': 22}})
            notify('thread/tokenUsage/updated', turnId=turn, tokenUsage={'last': {'inputTokens': 30, 'outputTokens': 7}})
            notify('thread/tokenUsage/updated', turnId=turn, tokenUsage={'total': {'inputTokens': 50, 'outputTokens': 11}})
            notify('turn/completed', turn={'id': turn, 'status': 'completed'})
        elif case == 'exit':
            return
        elif case in FAILURES:
            error = {'message': 'scripted provider failure', 'codexErrorInfo': FAILURES[case][0]}
            if case == 'credits':
                error['data'] = {'rateLimitReachedType': 'workspace_owner_credits_depleted'}
            if case == 'disconnected':
                notify('item/agentMessage/delta', turnId=turn, delta='partial reply')
            notify('error', turnId=turn, willRetry=False, error=error)
            notify('turn/completed', turn={'id': turn, 'status': 'failed', 'error': error})


def run(binary, cases, recordings_dir):
    for case in cases:
        mode = 'image' if case == 'image-path' else case if case in ('schema', 'image', 'cancel') else 'text'
        with tempfile.TemporaryDirectory(prefix='radiant-wire-') as directory:
            env = {**os.environ, 'CODEX_BIN': str(Path(__file__).resolve()), 'RADIANT_WIRE_FIXTURE': case,
                   'RADIANT_AI_SELFTEST_DIR': directory, 'RADIANT_WIRE_RECORDINGS_DIR': str(recordings_dir)}
            output = subprocess.run([binary, '--ai-selftest=' + mode], env=env, text=True,
                                    capture_output=True, timeout=20)
            events = re.findall(r'^\[\+\d+ ms\] (\{.*\})$', output.stderr, flags=re.M)
            events = [json.loads(row) for row in events]
            terminal = next((event for event in events if event['kind'] in ('done', 'error', 'cancelled')), {})
            expected = (None, 'credits_depleted', 0) if case == 'quota-preflight' else FAILURES.get(case, (None, {'exit': 'process_exited', 'turn-drift': 'protocol', 'notification-drift': 'protocol'}.get(case), 1))
            wanted = {'kind': 'error', 'code': expected[1]} if expected[1] else {'kind': 'cancelled' if case == 'cancel' else 'done'}
            assert all(terminal.get(key) == value for key, value in wanted.items()), output.stderr
            calls = [json.loads(row) for row in (Path(directory) / 'peer.jsonl').read_text().splitlines()]
            assert Counter(row['method'] for row in calls)['turn/start'] == expected[2], calls
            assert 'stale fixture delta' not in output.stderr, output.stderr
            if case == 'schema':
                assert any(row['method'] == 'turn/start' and row['schema'] for row in calls)
                assert json.loads(output.stderr.split('[selftest] text:\n')[-1].strip())
            if case == 'cancel':
                assert any(row['method'] == 'turn/interrupt' for row in calls)
                trace = next(Path(directory).glob('cache/ai-protocol-logs/*.jsonl'))
                rows = [json.loads(row) for row in trace.read_text().splitlines()]
                assert any(row.get('kind') == 'turnCompleted' and row.get('itemCount') == 0 for row in rows)
            if case in ('image', 'image-path'):
                assert any(event['kind'] == 'image' for event in events)
                assert list(Path(directory).glob('data/assets/*.png'))
            if case == 'usage-events':
                assert terminal.get('usage') == {'inputTokens': 50, 'outputTokens': 11}, output.stderr
                assert 'rateLimits event: 22' in output.stderr, output.stderr
            if case == 'svg':
                assert '<svg' in output.stderr
            print(case, json.dumps(wanted), f'{expected[2]} turn(s)')


if __name__ == '__main__':
    if os.environ.get('RADIANT_WIRE_FIXTURE'):
        serve(os.environ['RADIANT_WIRE_FIXTURE'], sys.argv[1:])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('--binary', default=str(PROJECT / 'src-tauri/target/debug/radiant'))
        parser.add_argument('--recordings-dir', type=Path, default=LOGS)
        parser.add_argument('cases', nargs='*')
        args = parser.parse_args()
        run(args.binary, args.cases or [*RECORDINGS, 'image', 'image-path', 'usage-events', *FAILURES, 'exit', 'turn-drift', 'notification-drift', 'quota-preflight'], args.recordings_dir.resolve())
