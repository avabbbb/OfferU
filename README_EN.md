<h1 align="center">OfferU</h1>

<p align="center">
  <em>Offer + U = OfferU — AI-powered resume tailoring system for fresh graduates</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Backend-FastAPI-009688?style=flat&logo=fastapi" />
  <img src="https://img.shields.io/badge/Frontend-Next.js%2014-000000?style=flat&logo=nextdotjs" />
  <img src="https://img.shields.io/badge/AI-Qwen%20%7C%20DeepSeek%20%7C%20OpenAI-412991?style=flat&logo=openai" />
  <img src="https://img.shields.io/badge/MCP-FastMCP%201.27-6366F1?style=flat" />
  <img src="https://img.shields.io/badge/Deploy-Docker-2496ED?style=flat&logo=docker" />
  <img src="https://img.shields.io/badge/License-MIT-brightgreen?style=flat" />
</p>

<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-core-features">Features</a> ·
  <a href="#-disclaimer">Disclaimer</a>
</p>

---

> 💡 Inspired by [santifer/career-ops](https://github.com/santifer/career-ops) (31k⭐, CLI-first AI job search system). While Career-Ops targets experienced professionals with technical skills (Claude Code CLI + $20/mo), OfferU brings the same AI-powered job search philosophy to **Chinese fresh graduates** — zero-barrier Web UI, Qwen models at ¥0.15/million tokens, and a fully localized Chinese workflow.

---

## 🎯 What Problem Does OfferU Solve?

**You're a liberal arts student facing campus recruitment, but you:**
- ❌ Don't know what to put on your resume — can't articulate achievements
- ❌ Manually customize resumes for each position — extremely inefficient
- ❌ Don't understand ATS keyword matching — get filtered out without knowing
- ❌ Can't use CLI tools — intimidated by command lines

**OfferU's approach:**
1. **AI-guided dialogue** → Helps you discover experiences from scratch, generates STAR-format bullet points
2. **One-click batch tailoring** → Select N jobs, AI recalls the most relevant experiences from your profile, generates tailored resumes per job
3. **Full Web UI** → Just open a browser, no technical background needed

---

## ✨ Core Features

### 🧠 Profile AI Dialogue (Career-Ops Style Onboarding)
- 5-topic progressive guidance: Education → Internship → Projects → Activities → Skills
- AI multi-turn dialogue extracts experiences from scratch, generates bullet point candidates per turn
- User confirms/edits each bullet → writes to profile in real-time
- Confidence scoring (high/medium/low), low-confidence items flagged for review
- **Anti-fabrication rules**: AI only extracts and rewrites from user's own words, never fabricates

### 📥 Three-Tab Job Triage (Smart Inbox)
- **Unscreened** → **Screened** → **Ignored** three-level triage workflow
- Batch folding: group by scraping batch, one-click batch triage
- Job pool management: create custom pools (e.g., "Internet Operations", "Banking MT Program")
- Hover quick actions: triage on mouse hover, no need to open details

### ⚡ Three-Section AI Resume Workspace (Core)
```
┌─────────────────────────────────────────────────────┐
│  ① Pool Selector   ② Job Selection    ③ Output     │
│                                                      │
│  [Internet Ops]    ☑ Tencent-Content   ┌──────────┐ │
│  [Banking MT]      ☑ Alibaba-Marketing │ SSE Prog │ │
│  [Ungrouped]       □ ByteDance-Brand   │ ████░ 2/3│ │
│                                        │          │ │
│                    [Per-job] [Combined] │ Preview  │ │
│                    [Generate]          └──────────┘ │
└─────────────────────────────────────────────────────┘
```
- **Per-job mode**: N jobs → N tailored resumes (SSE streaming progress)
- **Combined mode**: N jobs → 1 general resume
- **Pipeline**: Profile bullet recall → JD keyword match → STAR rewrite → save as Resume
- **Source tracking**: Each resume labeled "Generated for Tencent-Content Operations"

### 🤖 MCP Server + AI Agent (13 Tools)
- Built-in Python AgentKernel with 31 skill protocols, per-skill tool allowlists, file-first runs/checkpoints, and HITL confirmation
- Optional MCP Server (FastMCP Streamable HTTP) for external coding-agent integration; disabled by default on desktop
- Web Agent Console: conversational control without requiring a local coding agent
- 13 MCP Tools: profile view / job stats / triage operations / resume generation / pool management
- LLM autonomous tool-chain decision making with multi-turn reasoning

### 🔍 Multi-Platform Job Scraping
- Pluggable scraper adapter architecture
- Supports: LinkedIn / BOSS Zhipin / Zhilian / Shixiseng / Corporate sites
- Flexible keyword + location + exclusion filter configuration
- Auto-creates scraping batches, jobs auto-tagged as "unscreened"

### 📊 Multi-LLM Support
- **Default**: Alibaba Cloud Qwen (qwen-flash ¥0.15/M tokens, lowest cost)
- Options: DeepSeek / OpenAI / SiliconFlow / Gemini / Zhipu / local Ollama
- One-click provider switching in Settings page
- All LLM calls via OpenAI-compatible interface

---

## 🚀 Quick Start

### Prerequisites

- Python 3.12+
- Node.js 18+
- [Docker](https://www.docker.com/products/docker-desktop/) (optional)
- Alibaba Cloud Bailian API Key ([free tier](https://bailian.console.aliyun.com/)) or other LLM key

### Option 1: Docker

```bash
git clone https://github.com/Paker-kk/OfferU.git
cd OfferU
cp .env.example .env
# Edit .env with your QWEN_API_KEY
docker compose up -d
```

### Option 2: Local Development

```bash
git clone https://github.com/Paker-kk/OfferU.git
cd OfferU

# Backend
cd backend
python -m venv .venv312
.venv312\Scripts\activate    # Linux/Mac: source .venv312/bin/activate
pip install -r requirements.txt
cp .env.example .env         # Edit with your QWEN_API_KEY
python run_server.py

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

| Service | Local Dev | Docker | Description |
|---|---|---|---|
| Frontend | http://localhost:3300 | http://localhost:3011 | Web application |
| Backend API | http://localhost:8000 | http://localhost:9000 | FastAPI + auto docs |
| API Docs | http://localhost:8000/docs | http://localhost:9000/docs | Swagger interactive docs |
| MCP Endpoint (opt-in) | http://localhost:8000/mcp | http://localhost:9000/mcp | Set `OFFERU_ENABLE_MCP=true` for external coding-agent clients |

> ⚠️ Local dev port is fixed to **3300** (Windows Hyper-V/WSL2 winnat excludes port 3000, causing `EACCES`; 3300 is not excluded). Changing the port requires syncing `frontend/package.json`, `frontend/src-tauri/tauri.conf.json`, and `frontend/src-tauri/src/lib.rs`. In Docker mode the frontend listens on 3011 inside the container and the backend is exposed on host port 9000.

---

## ⚠️ Disclaimer

### API Key Security
- Your API keys are managed by you — this project **does not** upload keys to any third-party server
- `.env` is excluded by `.gitignore` — **never** commit files containing real keys

### Data & Privacy
- All data stored in your local database
- AI API calls send resume/JD content to the AI provider — review their privacy policies

### Web Scraping
- Scraper adapters are for educational and research purposes only
- Check target websites' robots.txt and ToS before use
- **Do not** use scraped data for commercial purposes

### AI-Generated Content
- AI-generated resumes are suggestions only — **fabrication is strictly prohibited**
- OfferU's profile guidance includes anti-fabrication rules and confidence scoring
- Final submitted resume is the user's own responsibility

---

## 🗺️ Roadmap

### Completed ✅
- [x] FastAPI backend + SQLAlchemy 2.0 async (Python 3.12)
- [x] Next.js 14 frontend (NextUI 2.4 dark theme)
- [x] Multi-platform scraper adapters
- [x] Profile AI dialogue guidance (5-topic + SSE streaming + bullet confirmation)
- [x] Three-tab job triage (batch folding + job pools)
- [x] Three-section AI resume workspace (pool → jobs → SSE generate)
- [x] Optional MCP Server (13 Tools, FastMCP Streamable HTTP)
- [x] Python AgentKernel (31 skills, file-first runs, checkpoints, HITL confirmation)
- [x] Resume source tracking
- [x] Multi-LLM support (Qwen / DeepSeek / OpenAI / SiliconFlow / Gemini / Zhipu / Ollama)

### In Progress 🔄
- [ ] PDF/Word resume import (pdfplumber + Qwen structured extraction)
- [ ] One-click apply AI optimization suggestions (HITL accept/reject)

### Future 📋
- [ ] Application automation (auto-fill & submit)
- [ ] ATS-optimized PDF export templates
- [ ] Interview prep module (STAR story bank + mock interviews)

---

## 📬 Contact

- **GitHub**: [Paker-kk/OfferU](https://github.com/Paker-kk/OfferU)
- **Inspired by**: [santifer/career-ops](https://github.com/santifer/career-ops)

Issues and PRs welcome!
