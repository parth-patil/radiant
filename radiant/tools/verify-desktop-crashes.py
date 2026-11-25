#!/usr/bin/env python3
"""Drive an isolated Radiant/WKWebView and validate a seeded interruption schedule."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import plistlib
import random
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parents[1]
INSTRUMENT = """
#[cfg(target_os = "macos")]
#[tauri::command]
async fn crash_gate_context(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    use objc2::{msg_send, sel};
    use objc2::runtime::{AnyObject, Bool};
    let (tx, rx) = tokio::sync::oneshot::channel();
    window.with_webview(move |wv| {
        // The test-only build reads the PID from its own WKWebView.
        let pid = unsafe {
            let webview = wv.inner().cast::<AnyObject>();
            let selector = sel!(_webProcessIdentifier);
            let responds: Bool = msg_send![webview, respondsToSelector: selector];
            if responds.as_bool() { msg_send![webview, _webProcessIdentifier] } else { 0i32 }
        };
        let _ = tx.send(pid);
    }).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "id": std::env::var("RADIANT_GATE_TRIAL").map_err(|error| error.to_string())?,
        "webview": rx.await.map_err(|error| error.to_string())?,
        "host": std::process::id(),
        "label": window.label(),
    }))
}
"""


def patch_file(path, before, after):
    contents = path.read_text()
    if contents.count(before) != 1:
        raise RuntimeError(f"Test instrumentation no longer matches {path.name}")
    path.write_text(contents.replace(before, after))


def prepare_frontend(project):
    marker = project / '.crash-gate-instrumented'
    ui = project / 'src/lib/ui'
    if marker.exists() and 'const script' in (ui / 'debug.ts').read_text():
        patch_file(ui / 'debug.ts',
                   "  const script = '/_gate.js';\n  void import(/* @vite-ignore */ script).then(module => module.run(c));",
                   "  void import('./crash-gate-fixture.js').then(module => module.run(c));")
    elif not marker.exists():
        patch_file(ui / 'App.svelte', 'if (import.meta.env.DEV) {', '{')
        patch_file(ui / 'debug.ts', '  const demo =',
                   "  void import('./crash-gate-fixture.js').then(module => module.run(c));\n  const demo =")
        marker.touch()
    adapter = project / 'src/lib/host/tauri.ts'
    if 'fixtureContext() {' not in adapter.read_text():
        declaration = 'export class TauriHost implements Host {'
        patch_file(adapter, declaration, declaration + "\n  fixtureContext() { return invoke('crash_gate_context'); }")
    shutil.copyfile(TOOLS / 'desktop-crash-script.js', ui / 'crash-gate-fixture.js')


def build(work, port, revision, *, release=False, scratch_assets=False, memory_driver=None, visible_documents=False):
    project = work / 'radiant'
    if not project.exists():
        archive = subprocess.check_output(['git', 'archive', revision, 'radiant'], cwd=REPO)
        subprocess.run(['tar', '-xf', '-', '-C', work], input=archive, check=True)
        (project / 'node_modules').symlink_to(REPO / 'radiant/node_modules', target_is_directory=True)
    host = project / 'src-tauri'
    configuration = host / 'tauri.conf.json'
    config = json.loads(configuration.read_text())
    config['identifier'] = 'app.radiant.crashgate.' + uuid.uuid4().hex
    config['productName'] = 'Radiant Crash Gate'
    config['build']['devUrl'] = f'http://127.0.0.1:{port}'
    config['app']['windows'][0].update(visible=False, focus=False)
    if scratch_assets:
        config['app']['security']['assetProtocol']['scope'].append(str(work) + '/**')
    configuration.write_text(json.dumps(config))
    patch_file(host / 'src/lib.rs', 'mod agent_access;', INSTRUMENT + '\nmod agent_access;')
    activation_policy = 'Accessory' if visible_documents else 'Prohibited'
    patch_file(host / 'src/lib.rs', '        .setup(|app| {',
               f'        .setup(|app| {{\n            app.set_activation_policy(tauri::ActivationPolicy::{activation_policy});')
    patch_file(host / 'src/lib.rs', '            codex::ai_status,',
               '            crash_gate_context,\n            codex::ai_status,')
    if memory_driver:
        shutil.copyfile(memory_driver, host / 'src/memory_driver.rs')
        patch_file(host / 'src/lib.rs', 'mod agent_access;', 'mod agent_access;\nmod memory_driver;')
        patch_file(host / 'src/lib.rs', '            crash_gate_context,',
                   '            crash_gate_context,\n            memory_driver::snapshot,')
        patch_file(host / 'src/lib.rs', '            open_files::setup(app.handle());',
                   '            open_files::setup(app.handle());\n            memory_driver::start(app.handle().clone());')
    # Keep fixture windows hidden and avoid writing macOS’s system recent list.
    opened = host / 'src/open_files.rs'
    visible = str(visible_documents).lower()
    patch_file(opened, '.title("Radiant")', f'.title("Radiant Crash Gate").visible({visible}).focused(false)')
    patch_file(opened, '        system_recent(&path);', '        let _ = &path;')
    patch_file(opened, '            let _ = window.set_focus();\n            Ok(())', '            Ok(())')
    patch_file(opened, 'Some(app.path().app_data_dir().ok()?.join("desktop-session.json"))',
               'let _ = app;\n    Some(PathBuf::from(std::env::var_os("RADIANT_GATE_PROFILE")?).join("desktop-session.json"))')
    patch_file(host / 'src/store/mod.rs', 'let base = app.path().app_data_dir()?;',
               'let base = std::env::var_os("RADIANT_GATE_PROFILE").map(PathBuf::from).unwrap_or(app.path().app_data_dir()?);')
    with (work / 'build.log').open('w') as log:
        subprocess.run(['cargo', 'build', '--locked', '--manifest-path', host / 'Cargo.toml',
                        *(['--release'] if release else [])],
                       env={**os.environ, 'CARGO_TARGET_DIR': str(work / 'target')},
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    return project, config['identifier']


class Trial:
    def __init__(self, mode, path, delay, profile=None):
        self.id = uuid.uuid4().hex
        self.mode = mode
        self.path = str(path)
        self.profile = str(profile or path.parent)
        self.delay = delay
        self.phase = 'edit'
        self.events = []
        self.changed = threading.Condition()

    def append(self, event):
        with self.changed:
            event['monotonic'] = time.monotonic()
            self.events.append(event)
            self.changed.notify_all()
            return {'mode': self.mode, 'phase': self.phase, 'path': self.path}

    def wait(self, kind, timeout=22):
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                for event in self.events:
                    if event['kind'] == 'error':
                        raise RuntimeError(event['message'])
                    if event['kind'] == kind:
                        return event
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f'{kind} absent; saw {[event["kind"] for event in self.events]}')
                self.changed.wait(left)


def event_server(trials):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            event = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            trial = trials.get(event.get('id'))
            if trial is None:
                self.send_error(404)
                return
            response = json.dumps(trial.append(event)).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            try:
                self.wfile.write(response)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def launch(binary, trial, log):
    return subprocess.Popen([binary], env={
        **os.environ, 'RADIANT_GATE_TRIAL': trial.id, 'RADIANT_GATE_PROFILE': trial.profile,
        **({'CODEX_BIN': str(TOOLS / 'fixtures/interrupted-generation.py')} if trial.mode == 'generation' else {})
    }, stdout=log, stderr=subprocess.STDOUT)


def webview_pid(host, event):
    target = event['webview']
    if event['host'] != host.pid or not isinstance(target, int) or target < 2 or target == host.pid:
        raise RuntimeError(f'Missing an isolated WKWebView process identity: {event}')
    image = subprocess.check_output(['ps', '-p', str(target), '-o', 'comm='], text=True).strip()
    if 'WebKit.WebContent' not in image:
        raise RuntimeError(f'PID {target} was not a WebKit content process: {image}')
    return target


def validate(trial, reopened, cut, cut_end=None):
    before = [event for event in trial.events if event['monotonic'] <= cut]
    ack = accepted = 0
    for event in before:
        number = event.get('number')
        if event['kind'] == 'accepted':
            if number != accepted + 1 or accepted != ack:
                raise RuntimeError(f'Accepted edit {number} beyond ACK {ack}')
            accepted = number
        if event['kind'] == 'ack':
            if number != ack + 1 or number != accepted or event['result'] is not True:
                raise RuntimeError(f'Unexpected or recovery-only native ACK {event}')
            ack = number
    with sqlite3.connect(f'{Path(trial.path).as_uri()}?mode=ro', uri=True) as database:
        text, = database.execute("select json from doc where id = 1").fetchone()
        doc = json.loads(text)
        disk = doc['nodes'][doc['roots'][0]]['text']
        latest = database.execute(
            "select result_json_hash from operation_log order by sequence desc limit 1"
        ).fetchone()
        if latest and latest[0] != hashlib.sha256(text.encode()).hexdigest():
            raise RuntimeError('Latest journal digest and materialized document diverged')
        if database.execute('pragma integrity_check').fetchone() != ('ok',):
            raise RuntimeError('SQLite integrity check failed')
    upper = accepted
    if cut_end is not None:
        upper = max((event['number'] for event in trial.events
                     if event['kind'] == 'accepted' and event['monotonic'] <= cut_end), default=0)
    disk_sequence = 0 if disk == 'Central topic' else int(disk.removeprefix('crash-edit:'))
    if not ack <= disk_sequence <= upper:
        raise RuntimeError(f'Reopened disk at {disk}, ACK={ack}, accepted={accepted}')
    if reopened['text'] != disk or reopened['dirty'] or (cut_end is None and reopened['recoveries']):
        raise RuntimeError(f'WebView did not restore the journal state: {reopened}, disk={disk}')
    if ack and reopened['undo'] not in ('Edit Text', None):
        raise RuntimeError(f'Unexpected Undo state: {reopened}')
    return {'ack': ack, 'accepted': accepted, 'disk': disk, 'recovery_count': reopened['recoveries']}


def validate_generation(trial, reopened, cut):
    acks = [e['titles'] for e in trial.events if e['kind'] == 'generation-ack' and e['monotonic'] <= cut]
    if not acks or len(acks[-1]) < 2:
        raise RuntimeError('The generation did not reach the native commit boundary')
    with sqlite3.connect(f'{Path(trial.path).as_uri()}?mode=ro', uri=True) as db:
        text, = db.execute('select json from doc where id=1').fetchone()
        digest, = db.execute('select result_json_hash from operation_log order by sequence desc limit 1').fetchone()
        if db.execute('pragma integrity_check').fetchone() != ('ok',) or hashlib.sha256(text.encode()).hexdigest() != digest:
            raise RuntimeError('The recovered generated map failed the SQLite or journal integrity check')
    doc = json.loads(text)
    titles = sorted(n['text'] for n in doc['nodes'].values())
    if not set(acks[-1]).issubset(titles) or reopened['titles'] != titles or not reopened['draft'] or reopened['busy']:
        raise RuntimeError('The reopened draft diverged from its acknowledged nodes or restarted the interrupted job')
    generated = [node for node in doc['nodes'].values() if node.get('origin', {}).get('by') == 'ai']
    root = next(node for node in generated if not node['parent'])
    if sorted(n['text'] for n in generated) != [f'Fixture topic {i}' for i in range(len(generated))]:
        raise RuntimeError('A streamed node was lost or duplicated')
    if set(root['children']) != {n['id'] for n in generated if n.get('parent') == root['id']} or len(root['children']) != len(generated) - 1:
        raise RuntimeError('The recovered generated tree is inconsistent')
    if int(Path(trial.path).stem.split('-')[-1]) % 2 and 'Earlier committed edit' not in titles:
        raise RuntimeError('The user edit made before generation was lost')
    if reopened['jobs'] != ['running'] or f'contains {len(generated)} nodes' not in reopened['notice']:
        raise RuntimeError('The recovered node count or saved job status was incorrect')
    return {'mode': 'generation', 'acknowledged': len(acks[-1]), 'reopenedNodes': len(titles), 'generated': len(generated), 'notice': reopened['notice']}


class ScratchVolume:
    def __init__(self, profile):
        self.image = profile / 'scratch.dmg'
        self.mount = profile / 'mounted'
        self.mount.mkdir()
        self.device = None
        self.volume = None
        subprocess.run(['hdiutil', 'create', '-size', '128m', '-fs', 'APFS',
                        '-volname', 'RadiantCrashFixture', self.image], check=True, capture_output=True)
        self.attach()

    def attach(self):
        output = subprocess.check_output(['hdiutil', 'attach', '-plist', '-nobrowse',
                                          '-mountpoint', self.mount, self.image])
        devices = plistlib.loads(output)['system-entities']
        self.device = next(e['dev-entry'] for e in devices
                           if e.get('content-hint') == 'GUID_partition_scheme')
        self.volume = next(e['dev-entry'] for e in devices if e.get('mount-point') == str(self.mount))

    def force_unmount(self):
        info = plistlib.loads(subprocess.check_output(['diskutil', 'info', '-plist', self.volume]))
        if info.get('MountPoint') != str(self.mount) or not self.mount.is_mount():
            raise RuntimeError('The requested forced unmount did not identify the scratch image')
        subprocess.run(['diskutil', 'unmount', 'force', self.volume], check=True, capture_output=True)
        if self.mount.is_mount():
            raise RuntimeError('The scratch volume did not unmount')

    def detach(self):
        if self.device is not None:
            subprocess.run(['hdiutil', 'detach', self.device], check=True, capture_output=True)
            self.device = None


def run_trial(binary, trial, log, volume=None):
    host = launch(binary, trial, log)
    verifier = None
    try:
        if trial.mode == 'seed':
            trial.wait('seeded')
            return
        editing = trial.wait('editing')
        target = webview_pid(host, editing) if trial.mode == 'webview' else host.pid
        if volume:
            editing = trial.wait('invoke')
        until = editing['monotonic'] + trial.delay
        time.sleep(max(0, until - time.monotonic()))
        trial.phase = 'verify'
        cut = time.monotonic()
        cut_end = None
        if volume:
            volume.force_unmount()
            cut_end = time.monotonic()
        os.kill(target, signal.SIGKILL)
        if trial.mode != 'webview':
            host.wait(8)
            if volume:
                volume.detach()
                volume.attach()
            verifier = launch(binary, trial, log)
        reopened = trial.wait('reopened')
        if verifier is not None and reopened['host'] != verifier.pid:
            raise RuntimeError('The verification window was not provided by the restarted host')
        if trial.mode == 'webview' and (host.poll() is not None or reopened['host'] != host.pid
                                       or reopened['webview'] == editing['webview']):
            raise RuntimeError('The host did not survive replacement of its WebView process')
        if trial.mode == 'generation':
            return validate_generation(trial, reopened, cut)
        return {'mode': trial.mode, 'actual_ms': (cut - editing['monotonic']) * 1000,
                'requested_ms': trial.delay * 1000,
                'unmount_ms': None if cut_end is None else (cut_end - cut) * 1000,
                **validate(trial, reopened, cut, cut_end)}
    finally:
        for process in (host, verifier):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', type=int, default=1000)
    parser.add_argument('--webview', type=int, default=1000)
    parser.add_argument('--power', type=int, default=0, help='Force-unmount a newly created APFS test image')
    parser.add_argument('--generation', type=int, default=0, help='Interrupt a streamed map from the offline stdio fixture')
    parser.add_argument('--seed', type=int, default=34)
    parser.add_argument('--jobs', type=int, default=1, help='Number of separate scratch profiles')
    parser.add_argument('--port', type=int, default=5249)
    parser.add_argument('--revision', default='HEAD')
    parser.add_argument('--prepared', type=Path, help='Reuse a workspace from this harness')
    args = parser.parse_args()
    if sys.platform != 'darwin' or min(args.host, args.webview, args.power, args.generation) < 0 or args.jobs < 1:
        parser.error('Requires macOS, nonnegative counts and at least one job')
    work = (args.prepared or Path(tempfile.mkdtemp(prefix='radiant-desktop-crashes.'))).resolve()
    print('Artifacts:', work, flush=True)
    if (work / 'gate.json').exists():
        config = json.loads((work / 'gate.json').read_text())
        if config['port'] != args.port:
            parser.error('Use the prepared fixture port')
        project = work / 'radiant'
    else:
        revision = subprocess.check_output(['git', 'rev-parse', args.revision], cwd=REPO, text=True).strip()
        project, identifier = build(work, args.port, revision)
        config = {'identifier': identifier, 'port': args.port, 'revision': revision}
        (work / 'gate.json').write_text(json.dumps(config))
    if not project.resolve().is_relative_to(work):
        parser.error('The fixture checkout must be inside its scratch directory')
    prepare_frontend(project)
    binary = work / config.get('binary', 'target/debug/radiant')
    trials = {}
    server = event_server(trials)
    randomizer = random.Random(args.seed)
    schedule = [(mode, index, randomizer.uniform(0.005, 0.185))
                for mode, count in [('host', args.host), ('webview', args.webview), ('power', args.power), ('generation', args.generation)]
                for index in range(count)]
    batch = Path(tempfile.mkdtemp(prefix='batch-', dir=work))
    results_lock = threading.Lock()
    stopped = threading.Event()
    with (work / 'frontend.log').open('w') as frontend_log, (work / 'native.log').open('w') as native_log:
        token = uuid.uuid4().hex
        frontend = subprocess.Popen(['node', TOOLS / 'desktop-crash-gate.mjs', project,
                                     str(args.port), str(server.server_port), token],
                                    cwd=project, stdout=frontend_log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline and frontend.poll() is None:
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/_gate-health', timeout=1) as health:
                        if health.read() == token.encode():
                            break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError(f'The scratch frontend failed to start. See {work / "frontend.log"}')
            def run_lane(lane, jobs):
                profile = batch / f'profile-{lane}'
                profile.mkdir()
                seed = Trial('seed', profile / 'seed.radiant', 0)
                trials[seed.id] = seed
                try:
                    run_trial(binary, seed, native_log)
                finally:
                    del trials[seed.id]
                with (batch / f'profile-{lane}.jsonl').open('w') as results:
                    for mode, index, delay in jobs:
                        if stopped.is_set():
                            return
                        volume = ScratchVolume(Path(tempfile.mkdtemp(prefix='apfs-', dir=profile))) if mode == 'power' else None
                        fixture = (volume.mount if volume else profile) / f'{mode}-{index}.radiant'
                        shutil.copyfile(seed.path, fixture)
                        trial = Trial(mode, fixture, delay, profile)
                        trials[trial.id] = trial
                        try:
                            result = run_trial(binary, trial, native_log, volume)
                            row = {'trial': index, 'seed': args.seed, **result}
                            results.write(json.dumps(row) + '\n')
                            results.flush()
                            with results_lock:
                                print(json.dumps(row), flush=True)
                        except (RuntimeError, TimeoutError, sqlite3.Error):
                            stopped.set()
                            (profile / 'failure.json').write_text(json.dumps(trial.events, indent=2))
                            raise
                        finally:
                            del trials[trial.id]
                            if volume:
                                volume.detach()
                        if not volume:
                            fixture.unlink()

            with ThreadPoolExecutor(max_workers=args.jobs) as executor:
                futures = [executor.submit(run_lane, lane, schedule[lane::args.jobs])
                           for lane in range(args.jobs) if schedule[lane::args.jobs]]
                try:
                    for future in futures:
                        future.result()
                finally:
                    stopped.set()
        finally:
            frontend.terminate()
            frontend.wait(8)
            server.shutdown()


if __name__ == '__main__':
    main()
