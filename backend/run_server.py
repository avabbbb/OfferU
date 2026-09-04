"""Quick launcher for uvicorn from correct directory"""
import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())
import uvicorn
from app.runtime_paths import configured_backend_port

uvicorn.run(
    "app.main:app",
    host="127.0.0.1",
    port=configured_backend_port(),
    reload=False,
    access_log=False,
)
