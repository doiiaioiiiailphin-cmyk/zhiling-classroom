import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import uvicorn


ROOT = Path(__file__).resolve().parent.parent


def stop(process: subprocess.Popen):
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            process.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            process.send_signal(signal.SIGTERM)
    except OSError:
        process.terminate()


def start_full_stack() -> int:
    vite = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
    if not vite.is_file():
        sys.exit("请先在项目根目录运行 npm ci")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    node_env = os.environ.copy()
    node_env["NODE_OPTIONS"] = f'{node_env.get("NODE_OPTIONS", "")} --dns-result-order=ipv4first'.strip()
    if os.name == "nt":
        def interrupt(_signal, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGBREAK, interrupt)
    processes = []
    try:
        processes.append(subprocess.Popen(
            [sys.executable, __file__], cwd=ROOT, creationflags=flags,
        ))
        processes.append(subprocess.Popen(
            ["node", str(vite), "--host", "localhost", "--port", "5173", "--strictPort"],
            cwd=ROOT, env=node_env, creationflags=flags,
        ))
        while all(process.poll() is None for process in processes):
            time.sleep(0.25)
        return next(process.returncode for process in processes if process.returncode is not None)
    except KeyboardInterrupt:
        return 0
    finally:
        for process in reversed(processes):
            stop(process)
        for process in reversed(processes):
            try:
                process.wait(timeout=25)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser(description="启动知聆课堂")
    parser.add_argument("--with-frontend", action="store_true", help="同时启动现有 Vite 前端")
    args = parser.parse_args()
    if args.with_frontend:
        sys.exit(start_full_stack())
    uvicorn.run(
        "app.main:app", host="127.0.0.1", port=8000, workers=1,
        ws="websockets", ws_max_size=262144, ws_max_queue=32, timeout_graceful_shutdown=25,
    )


if __name__ == "__main__":
    main()
