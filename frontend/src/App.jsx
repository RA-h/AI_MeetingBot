import { useEffect, useMemo, useState } from 'react';
import WordSharePie from './WordSharePie.jsx';

const API_BASE = 'http://localhost:8000';

// Simple frontend-only status derived from local activity
function deriveUiStatus(botId, botState) {
    if (!botId) {
        return { label: 'Idle', tone: 'idle' }; // no bot yet
    }
    if (!botState) {
        return { label: 'Starting…', tone: 'idle' }; // bot created, waiting for first poll
    }

    const hasTranscripts = Array.isArray(botState.transcripts) && botState.transcripts.length > 0;
    const hasParticipants =
        botState.participants && Object.keys(botState.participants).length > 0;
    const hasPartial = typeof botState.partialTranscript === 'string'
        && botState.partialTranscript.length > 0;

    if (hasTranscripts || hasParticipants || hasPartial) {
        return { label: 'Active', tone: 'active' };
    }

    return { label: 'Idle', tone: 'idle' };
}

export default function App() {
    const [meetingUrl, setMeetingUrl] = useState('');
    const [botId, setBotId] = useState(null);
    const [botState, setBotState] = useState(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const [pollIntervalMs] = useState(1000);

    // Derived lists
    const participantsList = useMemo(() => {
        if (!botState?.participants) return [];
        return Object.values(botState.participants).sort((a, b) =>
            a.name.localeCompare(b.name),
        );
    }, [botState]);

    const transcripts = botState?.transcripts || [];
    const partialTranscript = botState?.partialTranscript || '';

    // Compute total words spoken per speaker (final transcripts only)
    const wordShareData = useMemo(() => {
        if (!transcripts.length) return [];

        const counts = {};
        for (const t of transcripts) {
            const speaker = t.speakerName || 'Unknown';
            const wordCount = (t.text || '')
                .trim()
                .split(/\s+/)
                .filter(Boolean).length;

            if (!wordCount) continue;
            counts[speaker] = (counts[speaker] || 0) + wordCount;
        }

        return Object.entries(counts).map(([name, value]) => ({
            name,
            value,
        }));
    }, [transcripts]);

    // Create a new bot
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
        } catch (err) {
            console.error('Error calling /api/bots:', err);
            setError('Could not reach backend.');
        } finally {
            setCreating(false);
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

        // initial fetch
        fetchState();
        const id = setInterval(fetchState, pollIntervalMs);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [botId, pollIntervalMs]);

    const statusMeta = deriveUiStatus(botId, botState);

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
                            placeholder="https://us02web.zoom.us/j/..."
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

                    {/* Word share pie chart */}
                    <div
                        style={{
                            borderRadius: 8,
                            background: '#020617',
                            padding: '6px 8px 4px',
                            marginBottom: 8,
                        }}
                    >
                        <div
                            style={{
                                fontSize: 12,
                                opacity: 0.8,
                                marginBottom: 4,
                            }}
                        >
                            Speaking share (by words)
                        </div>
                        <WordSharePie data={wordShareData}/>
                    </div>

                    <div className="participants-list">
                        {!botId && (
                            <div style={{opacity: 0.6, fontSize: 13}}>
                                Create a bot to start tracking participants.
                            </div>
                        )}

                        {botId && participantsList.length === 0 && (
                            <div style={{opacity: 0.6, fontSize: 13}}>
                                No participant events received yet.
                            </div>
                        )}

                        {participantsList.map((p) => (
                            <ParticipantRow key={p.id} p={p}/>
                        ))}
                    </div>
                </section>

            </main>

            <footer className="footer">
                <span>
                    Polling bot state every {pollIntervalMs / 1000}s from{' '}
                    <code style={{opacity: 0.9}}>GET /api/bots/:id/state</code>.
                </span>
                <span style={{textAlign: 'right'}}>
                    Webhook: <code>{'<PUBLIC_URL>/api/recall/webhook'}</code>
                </span>
            </footer>
        </div>
    );
}

function BotStatusPill({label, tone}) {
    const cls =
        tone === 'active'
            ? 'status-pill status-pill--active'
            : tone === 'error'
                ? 'status-pill status-pill--error'
                : 'status-pill status-pill--idle';

    return (
        <div className={cls}>
            <span className="status-pill-dot"/>
            <span>{label}</span>
        </div>
    );
}

function ParticipantRow({p}) {
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
                'participant-row' +
                (isSpeaking ? ' participant-row--speaking' : '')
            }
        >
            <div className="participant-avatar">{initials}</div>

            <div className="participant-meta">
                <div className="participant-name-line">
                    <span className="participant-name">{p.name}</span>
                    {p.isHost && (
                        <span className="participant-badge">Host</span>
                    )}
                    {!inCall && (
                        <span className="participant-badge">Left</span>
                    )}
                </div>
                <div className="participant-sub">
                    {p.email ? p.email + ' · ' : ''}
                    {inCall ? 'In call' : 'Not in call'}
                </div>
            </div>

            {isSpeaking && (
                <span className="participant-speaking-tag">speaking</span>
            )}
        </div>
    );
}

