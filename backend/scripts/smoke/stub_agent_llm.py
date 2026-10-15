"""Scripted OpenAI-compatible streaming stub for the embedded Agent smoke.
Each request that carries tools pops the next step from /tmp/agent_script.json:
{"tool": name, "args": {...}} or {"text": "..."}. Every request is logged."""
import json, time
from http.server import BaseHTTPRequestHandler, HTTPServer
SCRIPT = "/tmp/agent_script.json"
LOG = "/tmp/agent_stub.log"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self._json({"data": [{"id": "stub", "object": "model"}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        msgs = body.get("messages", [])
        with open(LOG, "a") as log:
            log.write(json.dumps({"tools": bool(body.get("tools")), "messages": msgs}, ensure_ascii=False) + "\n")
        step = {"text": "好的。"}
        if body.get("tools"):
            script = json.load(open(SCRIPT))
            if script:
                step = script.pop(0)
                json.dump(script, open(SCRIPT, "w"))
        if not body.get("stream"):
            return self._json({"id": "x", "object": "chat.completion", "created": int(time.time()), "model": "stub",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": step.get("text", "ok")}, "finish_reason": "stop"}]})
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        def chunk(delta, finish=None):
            data = {"id": "x", "object": "chat.completion.chunk", "created": int(time.time()), "model": "stub",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
        if "tool" in step:
            chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{int(time.time()*1000)}", "type": "function",
                   "function": {"name": step["tool"], "arguments": json.dumps(step["args"], ensure_ascii=False)}}]})
            chunk({}, "tool_calls")
        else:
            chunk({"role": "assistant", "content": step["text"]}); chunk({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
    def _json(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200)
        self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

HTTPServer(("127.0.0.1", 9914), H).serve_forever()
