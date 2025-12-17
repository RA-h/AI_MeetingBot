// frontend/src/App.jsx
import { useEffect, useMemo, useState } from 'react';
import WordSharePie from './WordSharePie';

const API_BASE = 'http://localhost:8000';
const PIE_COLORS = [
    '#7a5af8',
    '#9b8cff',
    '#5fc4e8',
    '#8aa0d6',
    '#b7c5f5',
    '#cbd5f5',
    '#6f86d6',
    '#91a3ee',
];

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

// Parse the LLM summary (markdown-style) into sections
function parseSummarySections(text) {
    const result = {
        overview: '',
        decisions: '',
        actions: '',
        inclusivity: '',
        other: '',
    };

    if (!text || typeof text !== 'string') return result;

    const lines = text.split(/\r?\n/);
    let currentKey = 'overview';
    const buffer = [];

    function flush() {
        if (!buffer.length) return;
        const chunk = buffer.join('\n').trim();
        if (!chunk) return;

        if (!result[currentKey]) {
            result[currentKey] = chunk;
        } else {
            result[currentKey] += '\n' + chunk;
        }
        buffer.length = 0;
    }

    for (const raw of lines) {
        const line = raw.trim();

        // heading line?
        const m = /^#{1,6}\s*(.+)$/.exec(line);
        if (m) {
            flush();
            const heading = m[1].toLowerCase();

            if (heading.includes('overview') || heading.includes('summary')) {
                currentKey = 'overview';
            } else if (heading.includes('decision')) {
                currentKey = 'decisions';
            } else if (heading.includes('action')) {
                currentKey = 'actions';
            } else if (heading.includes('inclusiv') || heading.includes('engagement')) {
                currentKey = 'inclusivity';
            } else {
                currentKey = 'other';
            }

            continue;
        }

        buffer.push(line);
    }

    flush();
    return result;
}

// Format seconds into mm:ss for timestamps
function formatTimeSec(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec)) return '';
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

export default function App() {
    const [meetingUrl, setMeetingUrl] = useState('');
    const [botId, setBotId] = useState(null);
    const [botState, setBotState] = useState(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState('');
    const [pollIntervalMs] = useState(1000);
    const [view, setView] = useState('live'); // 'live' | 'summary'

    // Live coaching state
    const [coachEnabled, setCoachEnabled] = useState(true);
    const [coachHint, setCoachHint] = useState('');
    const [coachBusy, setCoachBusy] = useState(false);

    const participantsList = useMemo(() => {
        if (!botState?.participants) return [];
        return Object.values(botState.participants).sort((a, b) =>
            (a.name || '').localeCompare(b.name || ''),
        );
    }, [botState]);

    const transcripts = botState?.transcripts || [];
    const partialTranscript = botState?.partialTranscript || '';
    const participation = botState?.participation || null;

    const wordCounts = useMemo(
        () => computeWordCounts(transcripts),
        [transcripts],
    );
    const pieData = useMemo(() => buildPieData(wordCounts), [wordCounts]);
    const speakerColors = useMemo(() => {
        const map = {};
        pieData.forEach((d, idx) => {
            map[d.name] = PIE_COLORS[idx % PIE_COLORS.length];
        });
        return map;
    }, [pieData]);

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

            // Backend returns { botId: '...' } in your current setup
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

    // End bot & go to summary view
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

    async function handleAskCoachNow() {
        console.log('[AskCoach] button clicked');

        if (!botId) {
            console.warn('[AskCoach] No botId yet, cannot ask coach.');
            setCoachHint('No bot is active yet.');
            return;
        }
        if (!coachEnabled) {
            console.warn('[AskCoach] Coach is disabled.');
            setCoachHint('Turn on the coach toggle first.');
            return;
        }
        if (!transcripts.length) {
            console.warn('[AskCoach] No transcripts yet for coach to analyze.');
            setCoachHint('Coach needs at least one transcript line.');
            return;
        }

        try {
            setCoachBusy(true);
            console.log('[AskCoach] calling /api/bots/' + botId + '/coach …');

            const res = await fetch(`${API_BASE}/api/bots/${botId}/coach`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ userName: 'You' }),
            });

            const data = await res.json().catch(() => ({}));
            console.log('[AskCoach] response:', res.status, data);

            if (!res.ok || data.error) {
                console.error('[AskCoach] Coach error:', data);
                setCoachHint('Coach request failed.');
                return;
            }

            if (data.finishReason) {
                console.log('[AskCoach] finish_reason:', data.finishReason);
            }

            const hintText =
                typeof data.hint === 'string' ? data.hint.trim() : '';

            if (hintText) {
                setCoachHint(hintText);
            } else if (data.hint === null) {
                setCoachHint('Coach had no specific hint right now.');
            } else if (data.finishReason === 'max_output_tokens') {
                setCoachHint('Coach hit a token limit; try again in a moment.');
            } else {
                setCoachHint('Coach response was empty.');
            }
        } catch (err) {
            console.error('[AskCoach] exception:', err);
            setCoachHint('Coach request threw an exception.');
        } finally {
            setCoachBusy(false);
        }
    }


    // Poll bot state (transcripts, participants, participation stats)
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

    // Live coaching polling (every ~75s)
    useEffect(() => {
        if (!botId || view !== 'live' || !coachEnabled) return;
        if (!transcripts.length) return;

        let cancelled = false;
        let polling = false;

        async function pollCoach() {
            if (cancelled || polling) return;
            polling = true;
            try {
                setCoachBusy(true);
                const res = await fetch(`${API_BASE}/api/bots/${botId}/coach`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        // Could also ask user for their name; for now use 'You'
                        userName: 'You',
                    }),
                });

                const data = await res.json().catch(() => ({}));
                if (!cancelled && res.ok) {
                    const hintText =
                        typeof data.hint === 'string' ? data.hint.trim() : '';
                    if (hintText) {
                        setCoachHint(hintText);
                    } else if (data.hint === null) {
                        setCoachHint('');
                    }
                }
            } catch (err) {
                if (!cancelled) console.error('Error calling /coach:', err);
            } finally {
                if (!cancelled) setCoachBusy(false);
                polling = false;
            }
        }

        // Call once, then at interval
        pollCoach();
        const id = setInterval(pollCoach, 50000); // ~50s

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [botId, view, coachEnabled, transcripts.length]);

    // If in summary view and we have a bot, show summary page
    if (view === 'summary' && botId && botState) {
        return (
            <>
                <SummaryView
                    botId={botId}
                    botState={botState}
                    statusMeta={statusMeta}
                    wordCounts={wordCounts}
                    pieData={pieData}
                    speakerColors={speakerColors}
                    onBack={() => setView('live')}
                />
                {coachHint && (
                    <CoachToast
                        message={coachHint}
                        onClose={() => setCoachHint('')}
                    />
                )}
            </>
        );
    }

    // LIVE CONSOLE VIEW
    return (
        <div className="app-shell">
            <header className="app-header">
                <div className="app-title">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="bolt" size={20} />
                        <h1 style={{ margin: 0 }}>Meeting AI Console</h1>
                    </div>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="wave" size={16} />
                        Create a bot, join a Zoom/Meet/Teams meeting, and watch
                        participants + transcripts in real time.
                    </span>
                </div>
            </header>

            {/* BOT CONTROL CARD */}
            <section className="card">
                <div className="card-header">
                    <div>
                        <h2>Meeting Link</h2>
                        <span>Paste a Zoom/Meet/Teams link to spawn a bot.</span>
                    </div>
                </div>

                <form
                    onSubmit={handleCreateBot}
                    style={{display: 'flex', flexDirection: 'column', gap: 10}}
                >
                    <div className="field-row">
                        <input
                            className="input"
                            type="text"
                            placeholder="https://us04web.zoom.us/j/..."
                            value={meetingUrl}
                            onChange={(e) => setMeetingUrl(e.target.value)}
                            style={{
                                borderRadius: 14,
                                padding: '12px 14px',
                                border: '1px solid rgba(229, 232, 242, 0.9)',
                                background: 'rgba(255,255,255,0.72)',
                                backdropFilter: 'blur(8px)',
                                boxShadow: '0 6px 14px rgba(15,23,42,0.06)',
                            }}
                        />
                        <button
                            className="button"
                            type="submit"
                            disabled={creating || !meetingUrl.trim()}
                            style={botId ? { display: 'none' } : undefined}
                        >
                            <Icon name="link" />
                            {creating ? 'Creating…' : botId ? 'Create new bot' : 'Create bot'}
                        </button>
                        {botId && (
                            <button
                                type="button"
                                className="button"
                                onClick={handleEndBot}
                            >
                                <Icon name="stop" />
                                End bot &amp; show summary
                            </button>
                        )}
                    </div>

                    <div
                        style={{
                            marginTop: 8,
                            fontSize: 12,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            flexWrap: 'wrap',
                        }}
                    >
                        <div className="toggle-chip">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={coachEnabled}
                                    onChange={(e) => setCoachEnabled(e.target.checked)}
                                />
                                <span>Enable live participation coach</span>
                            </label>
                        </div>

                        <button
                            type="button"
                            onClick={handleAskCoachNow}
                            className="button"
                            disabled={coachBusy}
                        >
                            <Icon name="chat" />
                            Ask coach now
                        </button>

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
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Icon name="mic" size={20} />
                                <h2>Transcript</h2>
                            </div>
                            <span>
                                Finalized utterances below. Partial line shows what&apos;s being
                                spoken right now.
                            </span>
                        </div>
                        <span className="badge-small">{transcripts.length} turns</span>
                    </div>

                    <div className="transcript-list">
                        {(!botId || (!transcripts.length && !partialTranscript)) && (
                            <div style={{opacity: 0.6, fontSize: 13}}>
                                {botId
                                    ? 'Waiting for the bot to hear some audio…'
                                    : 'Create a bot and start talking in the meeting.'}
                            </div>
                        )}

                        {transcripts.map((t) => (
                            <div key={t.id} className="transcript-item">
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: 8,
                                    }}
                                >
                                    <div className="transcript-speaker">
                                        {t.speakerName}
                                    </div>
                                    {typeof t.startSec === 'number' && (
                                        <div
                                            style={{
                                                fontSize: 11,
                                                opacity: 0.7,
                                                fontVariantNumeric: 'tabular-nums',
                                            }}
                                        >
                                            {formatTimeSec(t.startSec)}
                                        </div>
                                    )}
                                </div>
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
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Icon name="people" size={20} />
                                <h2>Participants</h2>
                            </div>
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
                                        <WordSharePie data={pieData} colorMap={speakerColors} />
                                        ) : (
                                            <div style={{ opacity: 0.6, fontSize: 12 }}>
                                                No words counted yet.
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {participation && (
                                    <ParticipationDiagnostics
                                        participation={participation}
                                        mode="live"
                                    />
                                )}

                                {participation && (
                                <SpeakingTimeRatio
                                    participation={participation}
                                    title="Speaking-time ratio"
                                    caption="Share of total words in the current call."
                                    colorMap={speakerColors}
                                />
                                )}

                                {participantsList.map((p) => (
                                    <ParticipantRow key={p.id} p={p} />
                                ))}
                            </>
                        )}
                    </div>
                </section>
            </main>

            {coachHint && (
                <CoachToast
                    message={coachHint}
                    onClose={() => setCoachHint('')}
                />
            )}
        </div>
    );
}

/* ---------- Small helper components ---------- */

function Icon({ name, size = 18, color = 'currentColor' }) {
    const common = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
    };

    switch (name) {
        case 'bolt':
            return (
                <svg {...common} fill={color}>
                    <path d="M13 2 5 13h5l-1 9 8-11h-5l1-9z" />
                </svg>
            );
        case 'wave':
            return (
                <svg {...common}>
                    <path d="M3 12c2.2 0 2.2-6 4.4-6S9.6 12 12 12s2.4-6 4.6-6S19.8 12 22 12" />
                </svg>
            );
        case 'link':
            return (
                <svg {...common}>
                    <path d="M10 14a5 5 0 0 1 0-7l1.5-1.5a4 4 0 0 1 5.7 5.6L16 12" />
                    <path d="M14 10a5 5 0 0 1 0 7l-1.5 1.5a4 4 0 1 1-5.7-5.6L8 12" />
                </svg>
            );
        case 'stop':
            return (
                <svg {...common} fill="none">
                    <rect x="6" y="6" width="12" height="12" rx="3" />
                </svg>
            );
        case 'chat':
            return (
                <svg {...common}>
                    <path d="M5 16v3l3-3h9a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3z" />
                </svg>
            );
        case 'mic':
            return (
                <svg {...common}>
                    <rect x="9" y="4" width="6" height="10" rx="3" />
                    <path d="M5 10a7 7 0 0 0 14 0" />
                    <path d="M12 17v3" />
                </svg>
            );
        case 'people':
            return (
                <svg {...common}>
                    <circle cx="8" cy="9" r="3" />
                    <circle cx="17" cy="9" r="3" />
                    <path d="M4 19c0-2.2 1.8-4 4-4h0c2.2 0 4 1.8 4 4" />
                    <path d="M13 19c0-1.9 1.6-3.5 3.5-3.5H17c1.9 0 3.5 1.6 3.5 3.5" />
                </svg>
            );
        case 'pie':
            return (
                <svg {...common} fill={color}>
                    <path d="M12 3a9 9 0 1 0 9 9h-9z" opacity="0.2" />
                    <path d="M12 3v9l7.8 2" />
                    <circle cx="12" cy="12" r="9" />
                </svg>
            );
        case 'doc':
            return (
                <svg {...common}>
                    <path d="M7 3h7l4 4v11a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" />
                    <path d="M14 3v4h4" />
                    <path d="M9 13h6M9 17h4M9 9h2" />
                </svg>
            );
        default:
            return (
                <svg {...common}>
                    <circle cx="12" cy="12" r="9" />
                </svg>
            );
    }
}

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

function SummarySectionCard({ title, children }) {
    return (
        <div
            style={{
                borderRadius: 10,
                border: '1px solid #e5e8f2',
                padding: 12,
                marginTop: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                background: '#ffffff',
            }}
        >
            <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{children}</div>
        </div>
    );
}

/* ---------- Speaking time ratio (shared between live + summary) ---------- */

function SpeakingTimeRatio({ participation, title, caption, colorMap }) {
    if (!participation || !participation.speakingShare) return null;

    const entries = Object.entries(participation.speakingShare || {})
        .map(([name, share]) => ({
            name,
            share: Number.isFinite(share) ? share : 0,
        }))
        .filter(({ share }) => share > 0)
        .sort((a, b) => b.share - a.share);

    if (!entries.length) return null;

    const domName =
        participation.dominantSpeaker || participation.window?.dominantSpeaker || null;
    const domShare = Number.isFinite(participation.dominantShare)
        ? participation.dominantShare
        : Number.isFinite(participation.window?.dominantShare)
        ? participation.window.dominantShare
        : null;
    const under = Array.isArray(participation.underrepresented)
        ? participation.underrepresented
        : [];

    return (
        <div
            style={{
                marginTop: 12,
                padding: 14,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.65)',
                border: '1px solid rgba(255,255,255,0.35)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                boxShadow: '0 16px 32px rgba(15,23,42,0.08)',
                backdropFilter: 'blur(10px)',
            }}
        >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
                {caption && <div style={{ fontSize: 12, color: '#6b7280' }}>{caption}</div>}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entries.map(({ name, share }) => {
                    const barColor = colorMap?.[name] || '#7a5af8';
                    return (
                    <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                fontSize: 12,
                            }}
                        >
                            <span>{name}</span>
                            <span style={{ color: '#6b7280' }}>{(share * 100).toFixed(0)}%</span>
                        </div>
                        <div
                            style={{
                                height: 10,
                                borderRadius: 999,
                                background: '#eef1f8',
                                overflow: 'hidden',
                            }}
                        >
                            <div
                                style={{
                                    width: `${Math.max(0, Math.min(share, 1)) * 100}%`,
                                    height: '100%',
                                    background: barColor,
                                }}
                            />
                        </div>
                    </div>
                )})}
            </div>

            <div style={{ fontSize: 12, color: '#475569' }}>
                {domName ? (
                    <>
                        Dominant speaker: <strong>{domName}</strong>
                        {domShare !== null && (
                            <> ({(domShare * 100).toFixed(0)}% of recent words)</>
                        )}
                    </>
                ) : (
                    'No dominant speaker detected yet.'
                )}
            </div>

            {under.length > 0 && (
                <div style={{ fontSize: 12, color: '#475569' }}>
                    Underrepresented:{' '}
                    {under
                        .map((u) =>
                            typeof u === 'string'
                                ? u
                                : `${u.name || 'Unknown'}${
                                      Number.isFinite(u.share) ? ` (${(u.share * 100).toFixed(0)}%)` : ''
                                  }`
                        )
                        .join(', ')}
                </div>
            )}
        </div>
    );
}

/* ---------- Participation Diagnostics ---------- */

function ParticipationDiagnostics({ participation, mode = 'live' }) {
    if (!participation) return null;

    const {
        totalWords,
        dominantSpeaker,
        dominantShare,
        underrepresented = [],
        interruptions,
        longestSilence = {},
    } = participation;

    const totalInterruptions = Number.isFinite(interruptions) ? interruptions : 0;
    const topInterrupter = participation.topInterrupter || null;
    const topInterruptionCount = Number.isFinite(participation.topInterruptionCount)
        ? participation.topInterruptionCount
        : null;
    const repetitionSummary = participation.repetitionSummary || {};

    const title =
        mode === 'live'
            ? 'Live participation diagnostics'
            : 'Participation diagnostics';

    return (
        <div
            style={{
                marginTop: 12,
                padding: 14,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.65)',
                border: '1px solid rgba(255,255,255,0.35)',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: 12,
                boxShadow: '0 16px 32px rgba(15,23,42,0.08)',
                backdropFilter: 'blur(10px)',
            }}
        >
            <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>

            {dominantSpeaker && dominantShare > 0 ? (
                <div>
                    <strong>Dominant speaker (last few turns):</strong>{' '}
                    {dominantSpeaker} &nbsp;(
                    {(dominantShare * 100).toFixed(0)}% of recent words)
                </div>
            ) : (
                <div>
                    <strong>Dominant speaker (last few turns):</strong> –
                </div>
            )}

            {underrepresented.length > 0 ? (
                <div>
                    <strong>Underrepresented voices:</strong>{' '}
                    {underrepresented
                        .map(
                            (u) => `${u.name} (${(u.share * 100).toFixed(0)}%)`,
                        )
                        .join(', ')}
                </div>
            ) : (
                <div>
                    <strong>Underrepresented voices:</strong> none detected yet
                </div>
            )}

            <div>
                <strong>Interruptions seen:</strong>{' '}
                {totalInterruptions || 0}
                {topInterrupter && (
                    <>
                        {' '}
                        — mostly by {topInterrupter} (×{topInterruptionCount})
                    </>
                )}
            </div>

            {longestSilence ? (
                <div>
                    <strong>Longest silence:</strong>{' '}
                    {formatTimeSec(longestSilence.durationSec)} between{' '}
                    {formatTimeSec(longestSilence.fromSec)} and{' '}
                    {formatTimeSec(longestSilence.toSec)}
                </div>
            ) : (
                <div>
                    <strong>Longest silence:</strong> none longer than ~15s so far
                </div>
            )}

            {Object.keys(repetitionSummary).length > 0 && (
                <div>
                    <strong>Repetition patterns:</strong>{' '}
                    {Object.entries(repetitionSummary)
                        .map(([name, info]) => {
                            const phrase =
                                (info.phrase || '').length > 40
                                    ? `${info.phrase.slice(0, 40)}…`
                                    : info.phrase || '(short utterance)';
                            return `${name} keeps repeating “${phrase}” (×${info.count})`;
                        })
                        .join('; ')}
                </div>
            )}

            <div style={{ opacity: 0.7 }}>
                <strong>Total words in call so far:</strong> {totalWords || 0}
            </div>
        </div>
    );
}

/* ---------- Summary View "page" ---------- */

function SummaryView({ botId, botState, wordCounts, pieData, onBack }) {
    const transcripts = botState.transcripts || [];
    const participantsList = Object.values(botState.participants || {}).sort(
        (a, b) => (a.name || '').localeCompare(b.name || ''),
    );
    const participation = botState.participation || null;
    const speakerColors = useMemo(() => {
        const map = {};
        pieData.forEach((d, idx) => {
            map[d.name] = PIE_COLORS[idx % PIE_COLORS.length];
        });
        return map;
    }, [pieData]);

    // AI summary local state
    const [summaryText, setSummaryText] = useState(botState.summary?.text || '');
    const [summaryFinishReason, setSummaryFinishReason] = useState(
        botState.summary?.finishReason || null,
    );
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [summaryError, setSummaryError] = useState('');

    // Keep local summary in sync with backend state
    useEffect(() => {
        setSummaryText(botState.summary?.text || '');
        setSummaryFinishReason(botState.summary?.finishReason || null);
    }, [botState.summary]);

    async function handleGenerateSummary() {
        if (!botId) return;
        setSummaryLoading(true);
        setSummaryError('');

        try {
            const res = await fetch(`${API_BASE}/api/bots/${botId}/summary`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.error) {
                console.error('Summary failed:', data);
                setSummaryError(data.error || 'Failed to generate summary.');
                return;
            }

            // Backend returns { text, createdAt, model }
            const newText =
                typeof data.text === 'string'
                    ? data.text
                    : typeof data.summaryText === 'string'
                    ? data.summaryText
                    : '';

            if (newText) setSummaryText(newText);
            if (data.finishReason) setSummaryFinishReason(data.finishReason);
        } catch (err) {
            console.error('Error calling /summary:', err);
            setSummaryError('Could not reach backend to summarize.');
        } finally {
            setSummaryLoading(false);
        }
    }

    const sections = useMemo(() => parseSummarySections(summaryText), [summaryText]);
    const hasStructuredSections =
        !!sections.overview ||
        !!sections.decisions ||
        !!sections.actions ||
        !!sections.inclusivity ||
        !!sections.other;

    return (
        <div className="app-shell">
            <header className="app-header">
                <div className="app-title">
                    <h1>Meeting summary</h1>
                    <span>
                        Final transcript, speaking share, and AI-powered summary +
                        inclusivity report.
                    </span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    
                    <button className="button button-secondary" onClick={onBack}>
                        Back to console
                    </button>
                </div>
            </header>

            <main className="layout-main layout-main--summary">
                {/* Left: transcript */}
                <section className="card">
                    <div className="card-header">
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Icon name="mic" size={20} />
                                <h2>Final transcript</h2>
                            </div>
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
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: 8,
                                    }}
                                >
                                    <div className="transcript-speaker">
                                        {t.speakerName}
                                    </div>
                                    {typeof t.startSec === 'number' && (
                                        <div
                                            style={{
                                                fontSize: 11,
                                                opacity: 0.7,
                                                fontVariantNumeric: 'tabular-nums',
                                            }}
                                        >
                                            {formatTimeSec(t.startSec)}
                                        </div>
                                    )}
                                </div>
                                <div className="transcript-text">{t.text}</div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Right: analytics + AI summary */}
                <section className="card">
                    <div className="card-header">
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Icon name="pie" size={20} />
                                <h2>Speaking analytics</h2>
                            </div>
                            <span>Word counts, participation, and summary.</span>
                        </div>
                    </div>

                    <div className="wordshare-card">
                        <div className="wordshare-header">
                            <span>Speaking share (by words)</span>
                        </div>
                        <div className="wordshare-chart">
                            {pieData.length > 0 ? (
                                <WordSharePie data={pieData} colorMap={speakerColors} />
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

                    {participation && (
                        <SpeakingTimeRatio
                            participation={participation}
                            title="Speaking-time ratio"
                            caption="Share of total words across the full call."
                            colorMap={speakerColors}
                        />
                    )}

                    {botState.participation && (
                        <ParticipationDiagnostics
                            participation={botState.participation}
                            mode="summary"
                        />
                    )}

                    <div
                        style={{
                            marginTop: 16,
                            padding: 14,
                            borderRadius: 12,
                            background: '#ffffff',
                            border: '1px solid #e5e8f2',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            boxShadow: '0 12px 28px rgba(15,23,42,0.08)',
                        }}
                    >
                        <div style={{ fontSize: 14, fontWeight: 600 }}>AI summary</div>
                        <div style={{ fontSize: 12, color: '#475569' }}>
                            This summary is generated using the full transcript and
                            participation signals (dominance, silence, underrepresentation,
                            interruptions). It is structured into sections for faster review.
                        </div>

                        <button
                            className="button"
                            type="button"
                            onClick={handleGenerateSummary}
                            disabled={summaryLoading}
                            style={{ marginTop: 4, alignSelf: 'flex-start' }}
                        >
                            <Icon name="doc" />
                            {summaryLoading ? 'Generating…' : 'Generate / refresh summary'}
                        </button>

                        {summaryError && (
                            <div
                                style={{
                                    marginTop: 4,
                                    fontSize: 12,
                                    color: '#fecaca',
                                }}
                            >
                                {summaryError}
                            </div>
                        )}

                        {summaryText && (
                            <div style={{ marginTop: 8 }}>
                                {summaryFinishReason === 'length' && (
                                    <div
                                        style={{
                                            fontSize: 11,
                                            color: '#fde68a',
                                            marginBottom: 6,
                                        }}
                                    >
                                        Note: The AI stopped early because it hit the length
                                        limit; content may be truncated.
                                    </div>
                                )}

                                {hasStructuredSections && (
                                    <>
                                        {sections.overview && (
                                            <SummarySectionCard title="Overview">
                                                {sections.overview}
                                            </SummarySectionCard>
                                        )}
                                        {sections.decisions && (
                                            <SummarySectionCard title="Decisions">
                                                {sections.decisions}
                                            </SummarySectionCard>
                                        )}
                                        {sections.actions && (
                                            <SummarySectionCard title="Action items">
                                                {sections.actions}
                                            </SummarySectionCard>
                                        )}
                                        {sections.inclusivity && (
                                            <SummarySectionCard title="Inclusivity & Engagement">
                                                {sections.inclusivity}
                                            </SummarySectionCard>
                                        )}

                                        {sections.other && (
                                            <SummarySectionCard title="Other Notes">
                                                {sections.other}
                                            </SummarySectionCard>
                                        )}
                                    </>
                                )}

                                {/* Fallback if parsing fails: show raw summary */}
                                {summaryText && !hasStructuredSections && (
                                    <SummarySectionCard title="Summary">
                                        {summaryText}
                                    </SummarySectionCard>
                                )}
                            </div>
                        )}

                        {!summaryText && (
                            <div
                                style={{
                                    marginTop: 4,
                                    fontSize: 12,
                                    opacity: 0.8,
                                }}
                            >
                                No summary generated yet. Click &quot;Generate / refresh
                                summary&quot; after the call to get a structured recap.
                            </div>
                        )}
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

/* ---------- Coach Toast ---------- */

function CoachToast({ message, onClose }) {
    return (
        <div
            style={{
                position: 'sticky',
                right: 16,
                bottom: 16,
                maxWidth: 320,
                background: 'rgba(255,255,255,0.82)',
                borderRadius: 12,
                padding: 14,
                boxShadow: '0 18px 36px rgba(15,23,42,0.16)',
                border: '1px solid rgba(229,232,242,0.9)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                fontFamily: 'Ubuntu, Segoe UI, system-ui, sans-serif',
                zIndex: 9999,
                top: 'auto',
            }}
        >
            <div
                style={{
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: '#334155',
                    marginBottom: 4,
                    fontWeight: 600,
                }}
            >
                Participation coach
            </div>
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: '#0f172a' }}>
                {message}
            </div>
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 8,
                    marginTop: 4,
                }}
                >
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            fontSize: 11,
                            padding: '4px 10px',
                            borderRadius: 999,
                            border: '1px solid rgba(229,232,242,0.9)',
                            background: 'rgba(247,248,253,0.9)',
                            color: '#334155',
                            cursor: 'pointer',
                            boxShadow: '0 10px 20px rgba(15,23,42,0.08)',
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = '#7a5af8';
                            e.currentTarget.style.color = '#ffffff';
                            e.currentTarget.style.border = '1px solid #7a5af8';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(247,248,253,0.9)';
                            e.currentTarget.style.color = '#334155';
                            e.currentTarget.style.border = '1px solid rgba(229,232,242,0.9)';
                        }}
                    >
                        Dismiss
                    </button>
            </div>
        </div>
    );
}
