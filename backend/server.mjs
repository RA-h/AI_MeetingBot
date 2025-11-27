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
        // 1) Try to stop recording (non-fatal if it fails)
        try {
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
                console.warn(
                    '[Bot] stop_recording failed:',
                    stopResp.status,
                    text,
                );
            } else {
                console.log('[Bot] stop_recording OK for', botId);
            }
        } catch (err) {
            console.warn('[Bot] stop_recording error (ignored):', err);
        }

        // 2) Remove bot from call
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

        botsState.set(botId, state);

        return res.json({ ok: true });
    } catch (err) {
        console.error('[Bot] Error in /api/bots/:id/stop:', err);
        return res.status(500).json({ error: 'Internal server error' });
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





