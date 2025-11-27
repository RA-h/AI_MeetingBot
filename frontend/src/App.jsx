// frontend/src/App.jsx
import { useEffect, useMemo, useState } from 'react';
import WordSharePie from './WordSharePie';

const API_BASE = 'http://localhost:8000';

function statusInfo(status) {
    if (!status || status === 'created') {
        return { label: 'Idle', tone: 'idle' };
    }
    if (
        status === 'in_call_recording' ||
        status === 'recording' ||
        status === 'active'
    ) {
        return { label: 'Recording', tone: 'active' };
    }
    if (status === 'joining_call' || status === 'joining_meeting' || status === 'starting') {
        return { label: 'Joining…', tone: 'idle' };
    }
    if (status === 'ended' || status === 'finished' || status === 'call_ended') {
        return { label: 'Finished', tone: 'finished' };
    }
    if (status === 'failed' || status === 'fatal') {
        return { label: 'Error', tone: 'error' };
    }
    return { label: status, tone: 'idle' };
}

// count words per speaker
function computeWordCounts(transcripts) {
    const counts = {};
    if (!Array.isArray(transcripts)) return counts;

    for (const t of transcripts) {
        const name = t.speakerName || 'Unknown';
        const text = (t.text || '').trim();
        if (!text) continue;
        const words = text.split(/\s+/).filter(Boolean).length;
        counts[name] = (counts[name] || 0) + words;
    }

    return counts;
}

// turn counts into pie data
function buildPieData(wordCounts) {
    return Object.entries(wordCounts)
        .map(([name, value]) => ({ name, value }))
        .filter((d) => d.value > 0);
}

export default function App() {
    const [meetingUrl, setMeetingUrl] = useState('');
    const [botId, setBotId] = useState(null);
    const [botState, setBotState] = useState(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const [pollIntervalMs] = useState(1000);
    const [view, setView] = useState('live'); // 'live' | 'summary'

    const participantsList = useMemo(() => {
        if (!botState?.participants) return [];
        return Object.values(botState.participants).sort((a, b) =>
            (a.name || '').localeCompare(b.name || ''),
        );
    }, [botState]);

    const transcripts = botState?.transcripts || [];
    const partialTranscript = botState?.partialTranscript || '';

    const wordCounts = useMemo(
        () => computeWordCounts(transcripts),
        [transcripts],
    );
    const pieData = useMemo(() => buildPieData(wordCounts), [wordCounts]);

    async function handleCreateBot(e) {
        e?.preventDefault();
        setError('');

        if (!meetingUrl.trim()) {
            setError('Please paste a meeting URL.');
            return;
        }

        setCreating(true);
        try {
            const res = await fetch(`${API_BASE}/api/bots`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ meetingUrl: meetingUrl.trim() }),
            });

            const data = await res.json();
            if (!res.ok) {
                console.error('Bot creation failed:', data);
                setError(data.error || 'Bot creation failed.');
                return;
            }

            setBotId(data.botId);
            setBotState(null);
            setView('live');
        } catch (err) {
            console.error('Error calling /api/bots:', err);
            setError('Could not reach backend.');
        } finally {
            setCreating(false);
        }
    }

    // NEW: end bot & show summary
    async function handleEndBot() {
        if (!botId) return;
        setError('');

        try {
            const res = await fetch(`${API_BASE}/api/bots/${botId}/stop`, {
                method: 'POST',
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok || data.error) {
                console.error('End bot failed:', data);
                setError(data.error || 'Failed to stop bot.');
                return;
            }

            setView('summary');
        } catch (err) {
            console.error('Error calling /api/bots/:id/stop:', err);
            setError('Could not reach backend to stop bot.');
        }
    }

    // Poll bot state
    useEffect(() => {
        if (!botId) return;

        let cancelled = false;
        const fetchState = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/bots/${botId}/state`);
                const data = await res.json();
                if (!cancelled) setBotState(data);
            } catch (err) {
                console.error('Error fetching bot state:', err);
            }
        };

        fetchState();
        const id = setInterval(fetchState, pollIntervalMs);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [botId, pollIntervalMs]);

    const status = botState?.status;
    const statusMeta = statusInfo(status);

    // If in summary view and we have a bot, show summary page
    if (view === 'summary' && botId && botState) {
        return (
            <SummaryView
                botId={botId}
                botState={botState}
                statusMeta={statusMeta}
                wordCounts={wordCounts}
                pieData={pieData}
                onBack={() => setView('live')}
            />
        );
    }

    // LIVE CONSOLE VIEW
    return (
        <div className="app-shell">
            <header className="app-header">
                <div className="app-title">
                    <h1>Meeting AI Bot Console</h1>
                    <span>
            Create a Recall bot, join a Zoom meeting, and watch participants +
            transcripts in real time.
          </span>
                </div>
                <div className="badge">
                    <span className="badge-dot" />
                    Backend: localhost:8000
                </div>
            </header>

            {/* BOT CONTROL CARD */}
            <section className="card">
                <div className="card-header">
                    <div>
                        <h2>Bot control</h2>
                        <span>Paste a Zoom/Meet/Teams link to spawn a bot.</span>
                    </div>
                    <BotStatusPill label={statusMeta.label} tone={statusMeta.tone} />
                </div>

                <form
                    onSubmit={handleCreateBot}
                    style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
                >
                    <div className="field-row">
                        <input
                            className="input"
                            type="text"
                            placeholder="https://us04web.zoom.us/j/..."
                            value={meetingUrl}
                            onChange={(e) => setMeetingUrl(e.target.value)}
                        />
                        <button
                            className="button"
                            type="submit"
                            disabled={creating || !meetingUrl.trim()}
                        >
                            {creating ? 'Creating…' : botId ? 'Create new bot' : 'Create bot'}
                        </button>
                        {botId && (
                            <button
                                type="button"
                                className="button button-secondary"
                                onClick={handleEndBot}
                            >
                                End bot &amp; show summary
                            </button>
                        )}
                    </div>

                    <div className="bot-meta">
            <span>
              Bot ID: <code>{botId || '— not created yet —'}</code>
            </span>
                        <span>
              Status: <code>{statusMeta.label}</code>
            </span>
                        <span>
              Transcripts: <code>{transcripts.length}</code>
            </span>
                        <span>
              Participants: <code>{participantsList.length}</code>
            </span>
                    </div>

                    {error && (
                        <div
                            style={{
                                marginTop: 4,
                                fontSize: 12,
                                color: '#fecaca',
                            }}
                        >
                            {error}
                        </div>
                    )}
                </form>
            </section>

            {/* LIVE LAYOUT */}
            <main className="layout-main">
                {/* Transcript card */}
                <section className="card">
                    <div className="card-header">
                        <div>
                            <h2>Transcript</h2>
                            <span>
                Finalized utterances below. Partial line shows what&apos;s being
                spoken right now.
              </span>
                        </div>
                        <span className="badge-small">{transcripts.length} turns</span>
                    </div>

                    <div className="transcript-list">
                        {(!botId || (!transcripts.length && !partialTranscript)) && (
                            <div style={{ opacity: 0.6, fontSize: 13 }}>
                                {botId
                                    ? 'Waiting for the bot to hear some audio…'
                                    : 'Create a bot and start talking in the meeting.'}
                            </div>
                        )}

                        {transcripts.map((t) => (
                            <div key={t.id} className="transcript-item">
                                <div className="transcript-speaker">{t.speakerName}</div>
                                <div className="transcript-text">{t.text}</div>
                            </div>
                        ))}

                        {partialTranscript && (
                            <div className="transcript-partial">
                                <span style={{ opacity: 0.7 }}>Live: </span>
                                {partialTranscript}
                            </div>
                        )}
                    </div>
                </section>

                {/* Participants card */}
                <section className="card">
                    <div className="card-header">
                        <div>
                            <h2>Participants</h2>
                            <span>Updated from participant_events.* in real time.</span>
                        </div>
                        <span className="badge-small">
              {participantsList.length} seen
            </span>
                    </div>

                    <div className="participants-list">
                        {!botId && (
                            <div style={{ opacity: 0.6, fontSize: 13 }}>
                                Create a bot to start tracking participants.
                            </div>
                        )}

                        {botId && participantsList.length === 0 && (
                            <div style={{ opacity: 0.6, fontSize: 13 }}>
                                No participant events received yet.
                            </div>
                        )}

                        {participantsList.length > 0 && (
                            <>
                                <div className="wordshare-card">
                                    <div className="wordshare-header">
                                        <span>Speaking share (by words)</span>
                                    </div>
                                    <div className="wordshare-chart">
                                        {pieData.length > 0 ? (
                                            <WordSharePie data={pieData} />
                                        ) : (
                                            <div style={{ opacity: 0.6, fontSize: 12 }}>
                                                No words counted yet.
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {participantsList.map((p) => (
                                    <ParticipantRow key={p.id} p={p} />
                                ))}
                            </>
                        )}
                    </div>
                </section>
            </main>

            <footer className="footer">
        <span>
          Polling bot state every {pollIntervalMs / 1000}s from{' '}
            <code>GET /api/bots/:id/state</code>.
        </span>
                <span style={{ textAlign: 'right' }}>
          Webhook: <code>{'<PUBLIC_URL>/api/recall/webhook'}</code>
        </span>
            </footer>
        </div>
    );
}

/* ---------- Small helper components ---------- */

function BotStatusPill({ label, tone }) {
    const cls =
        tone === 'active'
            ? 'status-pill status-pill--active'
            : tone === 'error'
                ? 'status-pill status-pill--error'
                : tone === 'finished'
                    ? 'status-pill status-pill--finished'
                    : 'status-pill status-pill--idle';

    return (
        <div className={cls}>
            <span className="status-pill-dot" />
            <span>{label}</span>
        </div>
    );
}

function ParticipantRow({ p }) {
    const isSpeaking = !!p.isSpeaking;
    const inCall = p.inCall !== false;

    const initials = (p.name || '?')
        .split(' ')
        .map((s) => s[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

    return (
        <div
            className={
                'participant-row' + (isSpeaking ? ' participant-row--speaking' : '')
            }
        >
            <div className="participant-avatar">{initials}</div>

            <div className="participant-meta">
                <div className="participant-name-line">
                    <span className="participant-name">{p.name}</span>
                    {p.isHost && <span className="participant-badge">Host</span>}
                    {!inCall && <span className="participant-badge">Left</span>}
                </div>
                <div className="participant-sub">
                    {p.email ? p.email + ' · ' : ''}
                    {inCall ? 'In call' : 'Not in call'}
                </div>
            </div>

            {isSpeaking && <span className="participant-speaking-tag">speaking</span>}
        </div>
    );
}

/* ---------- Summary View "page" ---------- */

function SummaryView({ botId, botState, statusMeta, wordCounts, pieData, onBack }) {
    const transcripts = botState.transcripts || [];
    const participantsList = Object.values(botState.participants || {}).sort(
        (a, b) => (a.name || '').localeCompare(b.name || ''),
    );

    return (
        <div className="app-shell">
            <header className="app-header">
                <div className="app-title">
                    <h1>Meeting summary</h1>
                    <span>
            Final transcript, speaking share, and a placeholder for AI summary.
          </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <BotStatusPill label={statusMeta.label} tone={statusMeta.tone} />
                    <button className="button button-secondary" onClick={onBack}>
                        ← Back to console
                    </button>
                </div>
            </header>

            <main className="layout-main layout-main--summary">
                {/* Left: transcript */}
                <section className="card">
                    <div className="card-header">
                        <div>
                            <h2>Final transcript</h2>
                            <span>
                All finalized utterances captured while the bot was in the call.
              </span>
                        </div>
                        <span className="badge-small">{transcripts.length} turns</span>
                    </div>

                    <div className="transcript-list">
                        {transcripts.length === 0 && (
                            <div style={{ opacity: 0.6, fontSize: 13 }}>
                                No transcript captured for this bot.
                            </div>
                        )}

                        {transcripts.map((t) => (
                            <div key={t.id} className="transcript-item">
                                <div className="transcript-speaker">{t.speakerName}</div>
                                <div className="transcript-text">{t.text}</div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Right: wordshare + AI summary stub */}
                <section className="card">
                    <div className="card-header">
                        <div>
                            <h2>Speaking analytics</h2>
                            <span>Word counts + high-level summary.</span>
                        </div>
                    </div>

                    <div className="wordshare-card">
                        <div className="wordshare-header">
                            <span>Speaking share (by words)</span>
                        </div>
                        <div className="wordshare-chart">
                            {pieData.length > 0 ? (
                                <WordSharePie data={pieData} />
                            ) : (
                                <div style={{ opacity: 0.6, fontSize: 12 }}>
                                    No words counted yet.
                                </div>
                            )}
                        </div>

                        {Object.keys(wordCounts).length > 0 && (
                            <div
                                style={{
                                    marginTop: 8,
                                    fontSize: 12,
                                    opacity: 0.8,
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 4,
                                }}
                            >
                                {Object.entries(wordCounts).map(([name, count]) => (
                                    <span key={name}>
                    <strong>{name}</strong>: {count} words
                  </span>
                                ))}
                            </div>
                        )}
                    </div>

                    <div
                        style={{
                            marginTop: 16,
                            padding: 12,
                            borderRadius: 10,
                            background: '#111318',
                            border: '1px dashed rgba(255,255,255,0.12)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                        }}
                    >
                        <div style={{ fontSize: 14, fontWeight: 600 }}>AI summary</div>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            This is a placeholder. Next step will be to call your LLM backend
                            here with the final transcript to generate an automatic summary
                            and participation insights.
                        </div>
                    </div>

                    <div
                        style={{
                            marginTop: 12,
                            fontSize: 11,
                            opacity: 0.7,
                        }}
                    >
                        Bot ID: <code>{botId}</code>
                    </div>
                    <div
                        style={{
                            fontSize: 11,
                            opacity: 0.7,
                        }}
                    >
                        Participants:{' '}
                        <code>
                            {participantsList.length > 0
                                ? participantsList.map((p) => p.name).join(', ')
                                : 'none'}
                        </code>
                    </div>
                </section>
            </main>
        </div>
    );
}


