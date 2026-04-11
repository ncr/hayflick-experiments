"""
Blockstudio Blender Bridge — HTTP server for MCP-driven 3D scene automation.

Hosts an HTTP API on localhost:3721 that the Node-side BridgeClient talks to.
The command protocol is intentionally editor-agnostic.

Usage:
    blender --background --python blender/server.py          # headless
    blender --python blender/server.py                       # GUI (visible)
    blender --python blender/server.py -- --port 3722        # custom port
"""

import sys
import os
import json
import time
import queue
import signal
import threading
import traceback
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from argparse import ArgumentParser

# Ensure this directory is importable
_BLENDER_DIR = os.path.dirname(os.path.abspath(__file__))
if _BLENDER_DIR not in sys.path:
    sys.path.insert(0, _BLENDER_DIR)

import bpy

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3721
SERVER_VERSION = "0.1.0"

# ---------------------------------------------------------------------------
# Command queue — HTTP thread enqueues, main thread processes
# ---------------------------------------------------------------------------

_command_queue = queue.Queue()
_server_started_at = None
_running = True


class CommandRequest:
    """A pending command from an HTTP request, waiting for main-thread execution."""

    __slots__ = ("cmd_type", "payload", "result", "error", "done")

    def __init__(self, cmd_type, payload):
        self.cmd_type = cmd_type
        self.payload = payload
        self.result = None
        self.error = None
        self.done = threading.Event()


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

# Registry — populated by register_command() or directly
_commands = {}


def register_command(name, handler):
    _commands[name] = handler


def _handle_health(payload):
    """Handled inline by the HTTP layer, not via the command queue."""
    pass


def _handle_scene_build(payload):
    from geometry import build_scene  # noqa: local import for lazy loading
    return build_scene(payload)


def _handle_scene_inspect(payload):
    return inspect_scene(payload)


def _handle_texture_apply(payload):
    from materials import apply_textures
    return apply_textures(payload)


def _handle_export_assets(payload):
    from export import export_assets
    return export_assets(payload)


def _handle_viewport_capture(payload):
    from capture import capture_viewport
    return capture_viewport(payload)


def _handle_project_new(payload):
    from project import project_new
    return project_new(payload)


def _handle_project_save(payload):
    from project import project_save
    return project_save(payload)


def _handle_project_close(payload):
    from project import project_close
    return project_close(payload)


def _handle_scene_validate(payload):
    return validate_scene(payload)


# Register all commands
_COMMAND_MAP = {
    "kit_create_wall_set": _handle_scene_build,
    "scene_build_example_room": _handle_scene_build,
    "scene_inspect": _handle_scene_inspect,
    "scene_validate": _handle_scene_validate,
    "texture_generate": _handle_texture_apply,
    "viewport_capture": _handle_viewport_capture,
    "export_assets": _handle_export_assets,
    "project_new": _handle_project_new,
    "project_save": _handle_project_save,
    "project_close": _handle_project_close,
}


def execute_command(cmd_type, payload):
    handler = _COMMAND_MAP.get(cmd_type)
    if handler is None:
        raise ValueError(f'Unsupported command "{cmd_type}"')
    return handler(payload)


# ---------------------------------------------------------------------------
# Scene inspection / validation stubs (filled in Phase 2)
# ---------------------------------------------------------------------------

def inspect_scene(payload):
    """Return current scene metadata."""
    from mathutils import Vector

    scene = bpy.context.scene
    objects = [obj for obj in scene.objects if obj.type in {"MESH", "EMPTY"}]

    bounds_min = [float("inf")] * 3
    bounds_max = [float("-inf")] * 3
    mesh_count = 0
    empty_count = 0

    for obj in objects:
        if obj.type == "MESH":
            mesh_count += 1
            for corner in obj.bound_box:
                world_co = obj.matrix_world @ Vector(corner)
                for i in range(3):
                    bounds_min[i] = min(bounds_min[i], world_co[i])
                    bounds_max[i] = max(bounds_max[i], world_co[i])
        elif obj.type == "EMPTY":
            empty_count += 1

    if mesh_count == 0:
        bounds_min = [0, 0, 0]
        bounds_max = [0, 0, 0]

    return {
        "project": {
            "name": os.path.basename(bpy.data.filepath) if bpy.data.filepath else "(unsaved)",
            "blenderVersion": ".".join(str(v) for v in bpy.app.version),
        },
        "meshCount": mesh_count,
        "emptyCount": empty_count,
        "objectNames": [obj.name for obj in objects],
        "bounds": {
            "min": [round(v, 6) for v in bounds_min],
            "max": [round(v, 6) for v in bounds_max],
        },
    }


def validate_scene(payload):
    """Validate scene against a manifest (stub)."""
    return {"ok": True, "issues": [], "warnings": ["Validation not yet implemented"]}


# ---------------------------------------------------------------------------
# Server status (consumed by BridgeClient.refreshStatus)
# ---------------------------------------------------------------------------

def build_server_status():
    return {
        "connected": True,
        "endpoint": f"http://{_server_host}:{_server_port}",
        "activeBridge": {
            "bridgeId": "blockstudio_blender_bridge",
            "bridgeVersion": SERVER_VERSION,
            "blenderVersion": ".".join(str(v) for v in bpy.app.version),
            "serverStartedAt": _server_started_at,
            "backend": "blender",
        },
        "project": {
            "open": bpy.data.filepath != "" or len(bpy.data.objects) > 0,
            "name": os.path.basename(bpy.data.filepath) if bpy.data.filepath else None,
        },
        "currentKit": None,
        "error": None,
    }


# ---------------------------------------------------------------------------
# HTTP Server
# ---------------------------------------------------------------------------

class BridgeRequestHandler(BaseHTTPRequestHandler):
    """Handles HTTP requests from the MCP server (Node.js PluginClient)."""

    # Suppress default logging — we do our own
    def log_message(self, format, *args):
        pass

    def _send_json(self, status_code, body):
        payload = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)

    def _check_auth(self):
        if not _server_token:
            return True
        auth = self.headers.get("Authorization", "")
        return auth == f"Bearer {_server_token}"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._check_auth():
            self._send_json(401, {"ok": False, "error": "Unauthorized"})
            return

        path = self.path.split("?")[0]
        if path == "/health":
            self._send_json(200, {"ok": True, "status": build_server_status()})
        else:
            self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if not self._check_auth():
            self._send_json(401, {"ok": False, "error": "Unauthorized"})
            return

        path = self.path.split("?")[0]
        if path != "/command":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b""

        try:
            body = json.loads(body_bytes) if body_bytes else {}
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "Invalid JSON body."})
            return

        cmd_type = body.get("type")
        if not cmd_type:
            self._send_json(400, {"ok": False, "error": "Missing command type."})
            return

        # Enqueue command for main thread execution
        req = CommandRequest(cmd_type, body.get("payload", {}))
        _command_queue.put(req)

        # Wait for main thread to process (up to 120s)
        if not req.done.wait(timeout=120):
            self._send_json(500, {"ok": False, "error": "Command timed out."})
            return

        if req.error:
            self._send_json(200, {
                "ok": False,
                "error": str(req.error),
                "status": build_server_status(),
            })
        else:
            self._send_json(200, {
                "ok": True,
                "result": req.result,
                "status": build_server_status(),
            })


# ---------------------------------------------------------------------------
# Main-thread command processor
# ---------------------------------------------------------------------------

def process_command_queue():
    """Drain the command queue on the main thread. Called by timer or loop."""
    processed = 0
    while not _command_queue.empty():
        try:
            req = _command_queue.get_nowait()
        except queue.Empty:
            break

        try:
            req.result = execute_command(req.cmd_type, req.payload)
        except Exception as exc:
            req.error = f"{exc.__class__.__name__}: {exc}"
            traceback.print_exc()
        finally:
            req.done.set()
            processed += 1

    return processed


def timer_callback():
    """bpy.app.timers callback for GUI mode — process commands, re-register."""
    process_command_queue()
    return 0.05  # re-check every 50ms


def background_loop():
    """Blocking main-thread loop for --background mode."""
    global _running
    print(f"[blockstudio] Blender bridge running in background mode. Ctrl+C to stop.")
    try:
        while _running:
            process_command_queue()
            time.sleep(0.05)
    except KeyboardInterrupt:
        print("\n[blockstudio] Shutting down.")


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

_server_host = DEFAULT_HOST
_server_port = DEFAULT_PORT
_server_token = ""


def parse_args():
    """Parse arguments after '--' in the blender command line."""
    global _server_host, _server_port, _server_token

    # Blender passes script args after '--'
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = ArgumentParser(description="Blockstudio Blender Bridge")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--token", default=os.environ.get("BLOCKSTUDIO_BRIDGE_TOKEN", ""))
    args = parser.parse_args(argv)

    _server_host = args.host
    _server_port = args.port
    _server_token = args.token


def start():
    global _server_started_at

    parse_args()

    # Start HTTP server in a daemon thread
    httpd = HTTPServer((_server_host, _server_port), BridgeRequestHandler)
    httpd.timeout = 1
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    _server_started_at = datetime.now(timezone.utc).isoformat()
    print(f"[blockstudio] Blender bridge v{SERVER_VERSION} listening on http://{_server_host}:{_server_port}")

    if bpy.app.background:
        # Background mode — run blocking loop on main thread
        background_loop()
        httpd.shutdown()
    else:
        # GUI mode — register timer, let Blender's event loop run
        bpy.app.timers.register(timer_callback, first_interval=0.05)
        print(f"[blockstudio] Timer registered. Blender GUI is active.")


# Run on import (blender --python server.py)
if __name__ == "__main__" or "server" in __file__:
    start()
