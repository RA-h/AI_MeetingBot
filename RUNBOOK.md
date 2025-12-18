# Inclusive AI Meeting Bot - Runbook

AI Meeting Bot built using Recall.ai Meeting Bot API + OpenAI Responses API + React + Vite for the frontend.

## Scope
- Audience: Developers and end users
- Environment: Local only
- Runtime: npm scripts

## Features (for reference)
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

## Prerequisites
- Node.js (LTS recommended)
- npm
- Cloudflare tunnel binary (cloudflared)
  - Windows: `winget install Cloudflare.cloudflared`
  - macOS: `brew install cloudflared`
- API keys in `backend/.env` (see `backend/.env.example`)
  - `RECALL_API_KEY`
  - `OPENAI_API_KEY`
  - `PUBLIC_BASE_URL` (filled after starting the tunnel unless you already have one)

## Setup
1. Copy environment file:
   - `copy backend/.env.example backend/.env`
2. Fill in API keys in `backend/.env`.
3. Install dependencies:
   - `cd backend` then `npm install`
   - `cd frontend` then `npm install`

## Start (Local)
Open three terminals and run in this order:
1. Tunnel (if you do not already have a public URL):
   - `cd backend`
   - `npm run tunnel`
   - Copy the public URL into `backend/.env` as `PUBLIC_BASE_URL`
2. Backend:
   - `cd backend`
   - `npm start`
3. Frontend:
   - `cd frontend`
   - `npm run dev`

Open the frontend URL shown by Vite, paste a meeting link, and start the bot.

## Stop
- In each terminal, press `Ctrl + C`.
- Windows/macOS: ensure all three terminals stop (tunnel, backend, frontend).

## Troubleshooting
### AI coach prompt feels delayed
- The coach auto-prompt is throttled to avoid spam.
- Use "Ask coach now" for immediate feedback.

### No transcript or participants
- Confirm the Recall bot joined the meeting.
- Confirm `PUBLIC_BASE_URL` is set and the tunnel is running.
- Check backend logs for webhook events.

### Summary does not generate
- Verify `OPENAI_API_KEY` is set in `backend/.env`.
- Check backend logs for OpenAI errors.

### Stale UI or missing analytics
- Restart the backend after code changes.
- Refresh the frontend page.
