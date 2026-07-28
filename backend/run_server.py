"""Quick launcher for uvicorn from correct directory"""
import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())
import uvicorn
uvicorn.run(
    "app.main:app",
    host="127.0.0.1",
    port=int(os.getenv("OFFERU_PORT", os.getenv("OFFERU_LEGACY_PORT", "8000"))),
    reload=False,
    access_log=False,
)
