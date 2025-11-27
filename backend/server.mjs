// backend/server.mjs
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import localtunnel from 'localtunnel';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_REGION = process.env.RECALL_REGION || 'us-west-2';
const PORT = parseInt(process.env.PORT || '8000', 10);

if (!RECALL_API_KEY) {
    throw new Error('RECALL_API_KEY is missing in .env');
}

// --- LLM / OpenAI config ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;

if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing in .env');
}

const RECALL_BASE = `https://${RECALL_REGION}.recall.ai`;

let publicBaseUrl = process.env.PUBLIC_BASE_URL || null;

// In-memory bot state
const botsState = new Map();

function normalizeParticipant(raw) {
    if (!raw) return null;

    const id = String(
        raw.id ??
        raw.participant_id ??
        raw.user_id ??
        raw.email ??
        raw.name ??
        'unknown',
    );

    const name = (raw.name || '').trim() || `Participant ${id}`;

    return {
        id,
        name,
        email: raw.email || null,
        isHost: !!raw.is_host,
        platform: raw.platform || null,
        inCall: true,
    };
}

function getWebhookUrl() {
    if (!publicBaseUrl) {
        throw new Error('publicBaseUrl not ready yet. Tunnel still starting.');
    }
    return `${publicBaseUrl}/api/recall/webhook`;
}

function buildCoachTranscriptWindow(state, maxUtterances = 24) {
    if (!state || !Array.isArray(state.transcripts) || state.transcripts.length === 0) {
        return 'No transcript yet.';
    }

    const slice = state.transcripts.slice(-maxUtterances);
    return slice
        .map((t) => `[${t.speakerName || 'Unknown'}] ${t.text || ''}`.trim())
        .join('\n');
}


function buildTranscriptForLLM(state) {
    if (!state || !Array.isArray(state.transcripts) || state.transcripts.length === 0) {
        return 'No transcript available.';
    }

    const lines = [];

    for (const t of state.transcripts) {
        const speaker = t.speakerName || 'Unknown';
        const text = (t.text || '').trim();
        if (!text) continue;
        lines.push(`[${speaker}] ${text}`);
    }

    return lines.join('\n');
}


app.get('/', (_req, res) => {
    res.send(`
    <html lang="en">
      <body style="font-family: system-ui; background:#111; color:#eee; padding:20px;">
        <h1>🧠 Meeting Bot Backend</h1>
        <p>Status: <strong>OK</strong></p>
        <p>Local: <code>http://localhost:${PORT}</code></p>
        <p>Public: <code>${publicBaseUrl || '(tunnel starting...)'}</code></p>
      </body>
    </html>
  `);
});

// Create Bot
app.post('/api/bots', async (req, res) => {
    try {
        const { meetingUrl } = req.body;

        if (!meetingUrl) {
            return res.status(400).json({ error: 'meetingUrl is required' });
        }

        if (!publicBaseUrl) {
            return res.status(503).json({ error: 'Tunnel not ready yet' });
        }

        const payload = {
            meeting_url: meetingUrl,
            recording_config: {
                // audio-only (no video_mixed_mp4)
                audio_mixed_mp3: {},

                transcript: {
                    provider: {
                        recallai_streaming: {
                            language_code: 'en',
                            mode: 'prioritize_low_latency',
                        },
                    },
                    diarization: {
                        use_separate_streams_when_available: true,
                    },
                },

                realtime_endpoints: [
                    {
                        type: 'webhook',
                        url: getWebhookUrl(),
                        events: [
                            'transcript.data',
                            'transcript.partial_data',
                            'participant_events.join',
                            'participant_events.leave',
                            'participant_events.update',
                            'participant_events.speech_on',
                            'participant_events.speech_off',
                        ],
                    },
                ],
            },
        };

        console.log('BOT PAYLOAD SENT TO RECALL:');
        console.log(JSON.stringify(payload, null, 2));

        const response = await fetch(`${RECALL_BASE}/api/v1/bot/`, {
            method: 'POST',
            headers: {
                Authorization: `Token ${RECALL_API_KEY}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('[Bot] Failed:', text);
            return res
                .status(500)
                .json({ error: 'Bot creation failed', details: text });
        }

        const data = await response.json();
        const botId = data.id;

        botsState.set(botId, {
            botId,
            meetingUrl,
            status: data.status || 'created',
            transcripts: [],
            participants: {},
            partialTranscript: '',
            ended: false,
            summary: null,
        });

        console.log('[Bot] Created:', botId);
        res.json({ botId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Webhook for realtime events
app.post('/api/recall/webhook', (req, res) => {
    // ACK quickly
    res.json({ ok: true });

    const evt = req.body;
    const botId =
        evt?.data?.bot?.id ||
        evt?.data?.recording?.bot_id ||
        evt?.data?.bot_id;

    if (!botId || !botsState.has(botId)) return;

    const state = botsState.get(botId);

    console.log('[Webhook] Event:', evt.event);

    switch (evt.event) {
        case 'transcript.data': {
            const words = Array.isArray(evt.data?.data?.words)
                ? evt.data.data.words
                : [];

            if (!words.length) break;

            const text = words
                .map((w) => w.text)
                .filter(Boolean)
                .join(' ');

            const speakerName =
                evt.data?.data?.participant?.name || 'Unknown';

            state.transcripts.push({
                id: `${Date.now()}-${state.transcripts.length}`,
                text,
                speakerName,
            });

            state.partialTranscript = '';
            break;
        }

        case 'transcript.partial_data': {
            const words = Array.isArray(evt.data?.data?.words)
                ? evt.data.data.words
                : [];

            if (!words.length) break;

            const text = words
                .map((w) => w.text)
                .filter(Boolean)
                .join(' ');

            state.partialTranscript = text;
            break;
        }

        default:
            if (evt.event.startsWith('participant_events.')) {
                // Some webhooks use data.participant, others data.data.participant
                const rawParticipant =
                    evt?.data?.data?.participant || evt?.data?.participant;

                const norm = normalizeParticipant(rawParticipant);
                if (!norm) break;

                if (evt.event === 'participant_events.join') {
                    state.participants[norm.id] = {
                        ...(state.participants[norm.id] || {}),
                        ...norm,
                        inCall: true,
                    };
                }

                if (evt.event === 'participant_events.leave') {
                    if (state.participants[norm.id])
                        state.participants[norm.id].inCall = false;
                }

                if (evt.event === 'participant_events.update') {
                    state.participants[norm.id] = {
                        ...(state.participants[norm.id] || {}),
                        ...norm,
                    };
                }

                if (evt.event === 'participant_events.speech_on') {
                    Object.keys(state.participants).forEach((id) => {
                        state.participants[id].isSpeaking = id === norm.id;
                    });
                }

                if (evt.event === 'participant_events.speech_off') {
                    if (state.participants[norm.id])
                        state.participants[norm.id].isSpeaking = false;
                }
            }
    }

    botsState.set(botId, state);
});

// --- NEW: Stop bot (leave call + stop recording) ---
app.post('/api/bots/:id/stop', async (req, res) => {
    const botId = req.params.id;

    const state = botsState.get(botId);
    if (!state) {
        return res.status(404).json({ error: 'Unknown bot id' });
    }

    try {
        // 1) stop recording
        const stopUrl = `${RECALL_BASE}/api/v1/bot/${botId}/stop_recording/`;
        const stopResp = await fetch(stopUrl, {
            method: 'POST',
            headers: {
                Authorization: `Token ${RECALL_API_KEY}`,
                accept: 'application/json',
            },
        });

        if (!stopResp.ok) {
            const text = await stopResp.text();
            console.error('[Bot] stop_recording failed:', stopResp.status, text);
            return res
                .status(500)
                .json({ error: 'Failed to stop recording', details: text });
        }

        console.log('[Bot] stop_recording OK for', botId);

        // 2) leave call
        const leaveUrl = `${RECALL_BASE}/api/v1/bot/${botId}/leave_call/`;
        const leaveResp = await fetch(leaveUrl, {
            method: 'POST',
            headers: {
                Authorization: `Token ${RECALL_API_KEY}`,
                accept: 'application/json',
            },
        });

        if (!leaveResp.ok) {
            const text = await leaveResp.text();
            console.error('[Bot] leave_call failed:', leaveResp.status, text);
            return res
                .status(500)
                .json({ error: 'Failed to remove bot from call', details: text });
        }

        console.log('[Bot] leave_call OK for', botId);

        // 3) Mark bot as ended in state
        state.ended = true;
        state.endedAt = new Date().toISOString();
        state.status = 'ended';

        Object.values(state.participants).forEach((p) => {
            p.inCall = false;
            p.isSpeaking = false;
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error('[Bot] Error in /api/bots/:id/stop:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// --- Live participation coach (Responses API) ---
app.post('/api/bots/:id/coach', async (req, res) => {
    const botId = req.params.id;
    const state = botsState.get(botId);

    if (!state) {
        return res.status(404).json({ error: 'Unknown bot id' });
    }

    if (!OPENAI_API_KEY) {
        return res
            .status(500)
            .json({ error: 'OPENAI_API_KEY is not configured on the backend' });
    }

    const userName = (req.body?.userName || '').trim() || 'You';

    const windowText = buildCoachTranscriptWindow(state, 24);

    const userPrompt = `
You are an AI "Participation Coach" for live online meetings.

Your job is to help ONE specific person (the target participant) find inclusive,
non-disruptive ways to speak up if they seem quiet.

Target participant: "${userName}"

Recent transcript window (most recent lines are at the bottom):
${windowText}

Instructions:

1. Look at how often the target participant's name appears compared to others.
   - If the target seems to have spoken at least once in the last ~10–15 turns
     AND their participation looks reasonably balanced, respond with EXACTLY:
     NO_HINT

2. Otherwise, if the target seems quiet or sidelined:
   - Imagine you're sending them a short, kind toast notification while the
     meeting is in progress.
   - Suggest one concrete way they could speak up next, in a way that is
     respectful and collaborative.
   - Keep it VERY short (ONE sentence, max 25 words).
   - Focus on questions, clarifications, or building on others' ideas, for example:
       - "You might ask if there are any open tasks you can own."
       - "You could summarize what you've heard and share your perspective."

3. Do NOT:
   - Tell them to interrupt people aggressively.
   - Criticize specific participants by name.
   - Reveal you are an AI model or mention "transcripts".

Output format:

- If no coaching is needed, respond with EXACTLY:
  NO_HINT

- Otherwise respond with ONE short sentence that can be shown directly as a toast.
`.trim();

    try {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                instructions:
                    'You are a gentle, practical, real-time meeting participation coach.',
                input: userPrompt,
                max_output_tokens: 80,
                temperature: 0.5,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('[AI coach] Error:', response.status, text);
            return res
                .status(500)
                .json({ error: 'Failed to generate coaching hint', details: text });
        }

        const json = await response.json();
        let hint = (json.output_text || '').trim();  // using output_text from Responses API :contentReference[oaicite:1]{index=1}

        if (!hint) {
            return res.json({ show: false, hint: null });
        }

        // Normalize "NO_HINT"
        if (/^no_hint$/i.test(hint)) {
            return res.json({ show: false, hint: null });
        }

        // Strip outer quotes if present
        if (
            (hint.startsWith('"') && hint.endsWith('"')) ||
            (hint.startsWith("'") && hint.endsWith("'"))
        ) {
            hint = hint.slice(1, -1).trim();
        }

        return res.json({ show: true, hint });
    } catch (err) {
        console.error('[AI coach] Unexpected error:', err);
        return res
            .status(500)
            .json({ error: 'Internal server error while coaching' });
    }
});

// --- AI Meeting Summary + Inclusivity Report (Responses API) ---
app.post('/api/bots/:id/summary', async (req, res) => {
    const botId = req.params.id;
    const state = botsState.get(botId);

    if (!state) {
        return res.status(404).json({ error: 'Unknown bot id' });
    }

    if (!OPENAI_API_KEY) {
        return res
            .status(500)
            .json({ error: 'OPENAI_API_KEY is not configured on the backend' });
    }

    const transcriptText = buildTranscriptForLLM(state);

    const userPrompt = `
You are an AI Meeting Assistant. Your task is to generate a comprehensive, structured summary and an inclusivity report based on the following meeting transcript.

Transcript:
${transcriptText}

Please produce a summary using the following sections, in this exact order and format:

---

## 1. Overview (3–5 sentences)
- Briefly describe the purpose of the meeting.
- Mention the major topics discussed.
- Summarize the general outcome (decisions, directions, next steps).
- Keep this section neutral and concise.

---

## 2. Key Decisions
Provide a bulleted list of confirmed decisions.
Each item should include:
- Decision summary
- Who made or confirmed it (if identifiable)
- Implications, if relevant.

---

## 3. Action Items
Extract clear, actionable tasks.
Each bullet should include:
- Task
- Assignee (if known)
- Deadline (if mentioned; otherwise "No deadline specified").

---

## 4. Risks, Concerns, or Open Questions
List any unresolved issues, uncertainties, or points requiring follow-up.

---

## 5. Participation Metrics (Quantitative)
Using the transcript patterns, estimate:
- Each participant's approximate share of speaking time (high/medium/low or percentages if obvious).
- Who spoke the most.
- Who spoke the least.
- Any periods of silence, lack of participation, or dominance.
If names are missing, use "Participant A", "Participant B", etc.

---

## 6. Inclusivity & Engagement Analysis (Qualitative)
Provide a short but meaningful analysis of how inclusive the meeting was. Include observations such as:
- If one person dominated the conversation.
- If quieter participants tried to speak but were not acknowledged.
- Whether decisions were made collaboratively or by a small subset.
- Tone of the discussion (collaborative, dismissive, rushed, etc.).
- Whether all relevant stakeholders were represented.
- Any signs of groupthink or exclusion.
Be sensitive and neutral; do not blame individuals.

---

## 7. Inclusivity Recommendations
Provide 3–5 actionable suggestions to improve meeting inclusivity next time, framed as best practices.

---

## 8. Final Summary (1 paragraph)
End with a short, holistic paragraph that combines outcomes with inclusivity observations, reflects on effectiveness, and mentions any next steps.
`.trim();

    try {
        const response = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                instructions:
                    'You are an AI assistant that writes concise, structured, neutral meeting summaries with inclusivity analysis.',
                input: userPrompt,
                max_output_tokens: 800,
                temperature: 0.4,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error('[AI summary] Error:', response.status, text);
            return res.status(500).json({
                error: 'Failed to generate AI summary',
                details: text,
            });
        }

        const json = await response.json();
        // Responses API exposes a convenience field `output_text` :contentReference[oaicite:0]{index=0}
        const summaryText = (json.output_text || '').trim() || 'Summary could not be generated.';

        state.summary = {
            text: summaryText,
            createdAt: new Date().toISOString(),
            model: OPENAI_MODEL,
        };
        botsState.set(botId, state);

        return res.json({ summary: state.summary });
    } catch (err) {
        console.error('[AI summary] Unexpected error:', err);
        return res
            .status(500)
            .json({ error: 'Internal server error while summarizing' });
    }
});

// Poll state
app.get('/api/bots/:id/state', (req, res) => {
    const botId = req.params.id;
    res.json(botsState.get(botId) || { error: 'not found' });
});


// Start backend + localtunnel
app.listen(PORT, async () => {
    console.log(`[Backend] Running on http://localhost:${PORT}`);

    if (process.env.PUBLIC_BASE_URL) {
        publicBaseUrl = process.env.PUBLIC_BASE_URL;
        console.log(`[Backend] Using PUBLIC_BASE_URL: ${publicBaseUrl}`);
        return;
    }

    console.log('[Backend] Starting localtunnel...');

    const tunnel = await localtunnel({
        port: PORT,
        subdomain: undefined,
    });

    publicBaseUrl = tunnel.url;

    console.log(`[Backend] LocalTunnel URL: ${publicBaseUrl}`);
    console.log(`[Backend] Webhook URL: ${publicBaseUrl}/api/recall/webhook`);

    tunnel.on('close', () => {
        console.log('[Backend] LocalTunnel closed');
    });
});





