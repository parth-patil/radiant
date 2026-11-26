# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
"""Exercise Radiant's normal browser entry point with the offline host."""

import argparse
import re
from contextlib import contextmanager
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

PROJECT = Path(__file__).resolve().parents[1]
ROOT_LABEL = "Field plan"
CHILD_LABEL = "Wetland observations"
NOTE = "Record the water level before sampling."
MAP_PATH = "/Offline field notes.radiant"
# Small in-memory picture fixture, passed through the inspector's normal file chooser.
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="16" fill="#0072b2"/></svg>'


@contextmanager
def app_server():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryFile() as log:
        command = ["bun", "node_modules/vite/bin/vite.js", "dev", "--host", "127.0.0.1", "--port", str(port), "--strictPort"]
        with subprocess.Popen(command, cwd=PROJECT, stdout=log, stderr=subprocess.STDOUT) as server:
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline and server.poll() is None:
                    try:
                        with urlopen(origin, timeout=2) as response:
                            if response.status == 200:
                                break
                    except (OSError, URLError):
                        time.sleep(.1)
                else:
                    log.seek(0)
                    raise RuntimeError("Could not start Radiant:\n" + log.read().decode(errors="replace"))
                yield origin
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


def launch_app(context, origin):
    page = context.new_page()
    page.goto(origin)
    page.wait_for_function("""() => {
        const app = window.__radiant;
        return app?.c.ready && app.c.isBrowser && app.c.host.shell === 'browser' &&
            !('__TAURI_INTERNALS__' in window) && app.renderer.stats.frames > 0;
    }""")
    return page


def edit_save_and_reopen(context, origin):
    page = launch_app(context, origin)
    canvas = page.get_by_label("Mind map canvas")
    editor = page.get_by_role("textbox", name="Node text", exact=True)
    canvas.focus()
    page.keyboard.type(ROOT_LABEL)
    expect(editor).to_have_value(ROOT_LABEL)
    editor.press("Tab")
    editor.fill(CHILD_LABEL)
    editor.press("Escape")
    expect(page.get_by_label("Mind map canvas")).to_have_attribute("aria-describedby", "canvas-selection")
    expect(page.locator("#canvas-selection")).to_have_text(CHILD_LABEL)
    page.keyboard.press("Control+z")
    expect(page.locator("#canvas-selection")).not_to_have_text(CHILD_LABEL)
    page.keyboard.press("Control+Shift+z")
    expect(page.locator("#canvas-selection")).to_have_text(CHILD_LABEL)

    page.get_by_role("button", name="Find", exact=True).click()
    find = page.get_by_role("dialog", name="Find in map")
    find.locator("input").fill("Wetland")
    find.get_by_role("button", name=CHILD_LABEL, exact=False).click()
    expect(page.locator("#canvas-selection")).to_have_text(CHILD_LABEL)

    inspector_toggle = page.get_by_title("Show or hide the inspector", exact=False)
    inspector = page.get_by_role("complementary", name="Inspector")
    if not inspector.is_visible():
        inspector_toggle.click()
    note = inspector.get_by_role("textbox", name="Note", exact=True)
    note.fill(NOTE)
    note.press("Tab")
    with page.expect_file_chooser() as file_chooser:
        inspector.get_by_role("button", name="Attach picture…", exact=True).click()
    file_chooser.value.set_files({"name": "sampling.svg", "mimeType": "image/svg+xml", "buffer": SVG})
    preview = inspector.get_by_role("img", name=CHILD_LABEL)
    expect(preview).to_be_visible()
    page.wait_for_function("() => window.__radiant.renderer.stats.imagesDrawn > 0")

    title = page.get_by_role("textbox", name="Map title")
    title.fill("Offline field notes")
    title.press("Enter")
    canvas.focus()
    page.once("dialog", lambda dialog: dialog.accept(MAP_PATH))
    page.keyboard.press("Control+s")
    page.wait_for_function("(path) => window.__radiant?.c.filePath === path && !window.__radiant.c.dirty", arg=MAP_PATH)
    page.reload()
    page.wait_for_function("window.__radiant?.c.ready")
    page.get_by_label("Mind map canvas").focus()
    page.once("dialog", lambda dialog: dialog.accept(MAP_PATH))
    page.keyboard.press("Control+o")
    page.wait_for_function("(path) => window.__radiant?.c.filePath === path", arg=MAP_PATH)
    expect(page.get_by_role("textbox", name="Map title")).to_have_value("Offline field notes")

    outline = page.get_by_role("complementary", name="Outline")
    if not outline.is_visible():
        page.get_by_title("Show or hide the outline", exact=False).click()
    outline.get_by_role("treeitem", name=CHILD_LABEL).click()
    inspector = page.get_by_role("complementary", name="Inspector")
    if not inspector.is_visible():
        page.get_by_title("Show or hide the inspector", exact=False).click()
    expect(inspector.get_by_role("textbox", name="Note", exact=True)).to_have_value(NOTE)
    expect(inspector.get_by_role("img", name=CHILD_LABEL)).to_be_visible()
    page.wait_for_function("() => window.__radiant.renderer.stats.imagesDrawn > 0")

    inspector.get_by_role("button", name="Export…", exact=True).click()
    export = page.get_by_role("dialog", name="Export map")
    export.get_by_role("combobox", name="Format", exact=True).select_option("markdown")
    with page.expect_download() as event:
        export.get_by_role("button", name="Export", exact=True).click()
    download = event.value
    assert download.suggested_filename.endswith(".md"), download.suggested_filename
    markdown = download.path().read_text()
    assert all(text in markdown for text in (ROOT_LABEL, CHILD_LABEL, NOTE)), markdown
    # The drawn formats (PNG, SVG, PDF) build the map through a second pipeline; the PDF also needs its page preview.
    export.get_by_role("combobox", name="Format", exact=True).select_option("pdf")
    save_pdf = export.get_by_role("button", name="Save PDF…", exact=True)
    expect(save_pdf).to_be_enabled()
    with page.expect_download() as event:
        save_pdf.click()
    download = event.value
    assert download.suggested_filename.endswith(".pdf"), download.suggested_filename
    assert download.path().read_bytes().startswith(b"%PDF-"), "PDF export is not a PDF"
    print("PASS keyboard editing, undo/redo, Find, picture upload, save/reopen, Markdown and PDF export")


def replay_and_worker(context, origin):
    page = launch_app(context, origin)
    topic = "Water quality"
    page.get_by_role("textbox", name="Topic for AI map").fill(topic)
    page.locator(".quick-generate").get_by_role("button", name="Generate").click()
    page.wait_for_function("""(topic) => {
        const { c, renderer } = window.__radiant;
        return c.gen?.liveGrowth && renderer.scene?.labels.some(label => label.text === topic);
    }""", arg=topic)
    page.wait_for_function("() => !window.__radiant.c.gen && Object.keys(window.__radiant.c.doc.nodes).length > 8")
    routes = page.evaluate("Object.values(window.__radiant.c.doc.aiJobs).map(job => [job.route, job.status])")
    assert routes == [["replay", "done"]], routes

    # Seed a document without replacing the host or the worker. The document
    # enters through the application's existing large-map fixture entry point.
    page.goto(origin + "/?demo=big&n=1000")
    page.wait_for_function("""() => {
        const app = window.__radiant;
        return app?.c.ready && app.pipeline.nodeCount === 1000 &&
            app.pipeline.lastLayoutSource === 'worker' && app.renderer.stats.meshTriangles > 0;
    }""")
    print("PASS built-in offline AI replay, worker layout and WebGL rendering")


def ai_engine_settings(context, origin):
    page = launch_app(context, origin)
    inspector = page.get_by_role("complementary", name="Inspector")
    if not inspector.is_visible():
        page.get_by_title("Show or hide the inspector", exact=False).click()

    def open_section():
        section = inspector.locator("details", has=page.locator("summary", has_text="AI engine"))
        section.locator("summary").click()
        expect(section.get_by_role("note")).to_contain_text("sample data")
        return section

    guidance = "You extend one branch of a study map for a curious ten-year-old.\nPrefer concrete examples."
    section = open_section()
    section.get_by_role("radio", name="Claude Code").check()
    section.get_by_label("Effort").select_option("max")
    prompt = section.get_by_role("textbox", name="Expansion prompt")
    prompt.fill(guidance)
    prompt.blur()
    expect(section.get_by_role("button", name="Reset to default")).to_be_enabled()
    page.wait_for_function("() => localStorage.getItem('radiant.expandGuidance') !== null")
    page.reload()
    page.wait_for_function("window.__radiant?.c.ready")
    inspector = page.get_by_role("complementary", name="Inspector")
    if not inspector.is_visible():
        page.get_by_title("Show or hide the inspector", exact=False).click()
    section = open_section()
    expect(section.get_by_role("radio", name="Claude Code")).to_be_checked()
    expect(section.get_by_label("Effort")).to_have_value("max")
    expect(section.get_by_role("textbox", name="Expansion prompt (customised)")).to_have_value(guidance)
    section.get_by_role("button", name="Reset to default").click()
    expect(section.get_by_role("textbox", name="Expansion prompt")).to_have_value(re.compile(r"^You extend one branch of an existing mind map\."))
    section.get_by_role("radio", name="Codex").check()
    print("PASS AI engine, effort and expansion prompt settings survive a reload")


def run(origin):
    parsed = urlsplit(origin)
    errors = []
    denied = []

    def protect(route):
        target = urlsplit(route.request.url)
        if (target.scheme, target.netloc) == (parsed.scheme, parsed.netloc):
            route.continue_()
        else:
            denied.append(route.request.url)
            route.abort()

    with sync_playwright() as driver:
        flags = ["--use-angle=metal"] if sys.platform == "darwin" else []
        browser = driver.chromium.launch(channel="chrome", args=flags)
        for workflow in (edit_save_and_reopen, replay_and_worker, ai_engine_settings):
            context = browser.new_context(viewport={"width": 1440, "height": 900}, service_workers="block")
            context.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
            context.route("http*://**/*", protect)
            workflow(context, origin)
            context.close()
        browser.close()
    assert not errors, errors
    assert not denied, denied
    print("PASS browser host only, no page errors or requests outside the local app")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Use a running Radiant dev server instead of opening a temporary one")
    args = parser.parse_args()
    subprocess.run(["bun", "tools/check-boundaries.mjs"], cwd=PROJECT, check=True)
    print("PASS front-end shell import boundary")
    if args.url:
        url = urlsplit(args.url)
        if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.path not in {"", "/"}:
            parser.error("Use a local Radiant development URL")
        run(args.url.rstrip("/"))
    else:
        with app_server() as origin:
            run(origin)


if __name__ == "__main__":
    main()
