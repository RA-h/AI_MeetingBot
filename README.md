# Inclusive AI Meeting Bot

AI Meeting Bot built using Recall.ai Meeting Bot API + OpenAI Responses API + React + Vite.

## Quick Start (Local)
1. Install prerequisites:
   - Cloudflare tunnel: Windows `winget install Cloudflare.cloudflared`, macOS `brew install cloudflared`
2. Create `backend/.env` from `backend/.env.example` and add API keys.
3. Start services (3 terminals, in order):
   - `cd backend` -> `npm install` (once) -> `npm run tunnel` -> paste `PUBLIC_BASE_URL` into `backend/.env`
   - `cd backend` -> `npm start`
   - `cd frontend` -> `npm install` (once) -> `npm run dev`
4. Open the Vite URL, paste a meeting link, and start the bot.

For detailed setup, start/stop, and troubleshooting, see `RUNBOOK.md`.

## Features
- Create a Recall.ai meeting bot from a Zoom/Meet/Teams link
- Live transcript streaming with partial (in-progress) line and auto-scroll
- Participant presence with join/leave status, speaking indicator, host/left badges
- Speaking analytics toggle: word-based vs time-based views (pie + bars)
- Word-share pie chart and time-based pie chart (tied to the Words/Time toggle)
- Participation diagnostics: dominant speaker, underrepresented voices, interruptions by speaker, turn-taking rate, silence metrics, dialogue balance
- Speaking timeline: per-speaker segments with silence gaps shaded and hover tooltips on segments
- Participation coach: on-demand hint plus auto-prompt
- AI summary + inclusivity report with sectioned overview, decisions, actions, and engagement notes
- Live <--> Summary views with back navigation and persistent analytics
