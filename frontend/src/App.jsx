// frontend/src/App.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
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
const EMPTY_TRANSCRIPTS = [];

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
        return { label: 'Joining...', tone: 'idle' };
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

// Format seconds into a human-readable time.
// - If the value looks like an absolute epoch timestamp (very large), show local clock time.
// - Otherwise, show h:mm:ss or m:ss from the start of the call.
function formatTimeSec(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec)) return '';
    const s = Math.max(0, Math.floor(sec));

    // Heuristic: if the seconds value is larger than ~2 days, treat it as epoch seconds.
    if (s > 172800) {
        const d = new Date(s * 1000);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Reusable hover styling for cards with a subtle purple lift.
function useHoverCard(strength = 'medium') {
    const [hover, setHover] = useState(false);
    const strong = strength === 'strong';
    const style = {
        transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
        transform: hover ? 'translateY(-2.2px)' : 'none',
        boxShadow: hover
            ? (strong ? '0 16px 36px rgba(122,90,248,0.20)' : '0 14px 28px rgba(122,90,248,0.16)')
            : '0 8px 18px rgba(15,23,42,0.08)',
        border: undefined,
    };
    const handlers = {
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
    };
    return { style, handlers };
}

export default function App() {
    const [meetingUrl, setMeetingUrl] = useState('');
    const [botId, setBotId] = useState(null);
    const [botState, setBotState] = useState(null);
    const [creating, setCreating] = useState(false);
    const [endRequested, setEndRequested] = useState(false);
    const [error, setError] = useState('');
    const [pollIntervalMs] = useState(1000);
    const [view, setView] = useState('live'); // 'live' | 'summary'
    const [speakingView, setSpeakingView] = useState('ratio'); // 'ratio' | 'duration'

    // Live coaching state
    const [coachEnabled, setCoachEnabled] = useState(true);
    const [coachHint, setCoachHint] = useState('');
    const [coachBusy, setCoachBusy] = useState(false);
    const lastCoachAtRef = useRef(0);

    const participantsList = useMemo(() => {
        if (!botState?.participants) return [];
        return Object.values(botState.participants).sort((a, b) =>
            (a.name || '').localeCompare(b.name || ''),
        );
    }, [botState]);

    const transcripts = botState?.transcripts ?? EMPTY_TRANSCRIPTS;
    const partialTranscript = botState?.partialTranscript || '';
    const transcriptListRef = useRef(null);
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
    const totalWordsCount =
        participation?.totalWords ??
        Object.values(wordCounts).reduce((sum, v) => sum + v, 0);
    const callDurationSec = participation?.durationSec ?? null;
    const liveTranscriptHover = useHoverCard('strong');
    const liveParticipantsHover = useHoverCard('strong');
    const meetingCardHover = useHoverCard('strong');
    const liveTimelineHover = useHoverCard('strong');

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
            setEndRequested(false);
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
        setEndRequested(true);

        try {
            const res = await fetch(`${API_BASE}/api/bots/${botId}/stop`, {
                method: 'POST',
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok || data.error) {
                console.error('End bot failed:', data);
                setError(data.error || 'Failed to stop bot.');
                setEndRequested(false);
                return;
            }

            setView('summary');
        } catch (err) {
            console.error('Error calling /api/bots/:id/stop:', err);
            setError('Could not reach backend to stop bot.');
            setEndRequested(false);
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
            console.log('[AskCoach] calling /api/bots/' + botId + '/coach ...');

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
                lastCoachAtRef.current = Date.now();
                return;
            }

            if (data.finishReason) {
                console.log('[AskCoach] finish_reason:', data.finishReason);
            }

            const hintText =
                typeof data.hint === 'string' ? data.hint.trim() : '';

            if (hintText) {
                setCoachHint(hintText);
                lastCoachAtRef.current = Date.now();
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

    // Auto-scroll transcript to bottom on new entries
    useEffect(() => {
        const el = transcriptListRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [transcripts.length, partialTranscript]);

    // Reset coach throttle when switching bots
    useEffect(() => {
        lastCoachAtRef.current = 0;
    }, [botId]);

    // Live coaching polling (every ~2 minutes, throttled)
    useEffect(() => {
        if (!botId || view !== 'live' || !coachEnabled) return;
        if (!transcripts.length) return;

        let cancelled = false;
        let polling = false;

        async function pollCoach() {
            if (cancelled || polling) return;
            const MIN_SPACING_MS = 2 * 60 * 1000; // ~2 minutes minimum gap
            const now = Date.now();
            if (now - lastCoachAtRef.current < MIN_SPACING_MS) {
                return;
            }
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
                        lastCoachAtRef.current = Date.now();
                    } else if (data.hint === null) {
                        setCoachHint('');
                        lastCoachAtRef.current = Date.now();
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
        const id = setInterval(pollCoach, 60000); // ~60s

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
                    speakingView={speakingView}
                    setSpeakingView={setSpeakingView}
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
            <section
                className="card"
                style={{ ...meetingCardHover.style }}
                {...meetingCardHover.handlers}
            >
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
                            {creating ? 'Creating...' : botId ? 'Create new bot' : 'Create bot'}
                        </button>
                        {botId && !endRequested && (
                            <button
                                type="button"
                                className="button"
                                onClick={handleEndBot}
                                disabled={endRequested}
                            >
                                <Icon name="stop" />
                                {endRequested ? 'Ending...' : 'End bot & show summary'}
                            </button>
                        )}

                        {botId && (endRequested || status === 'ended' || view === 'summary') && (
                            <button
                                type="button"
                                className="button"
                                onClick={() => setView('summary')}
                            >
                                <Icon name="doc" />
                                Show summary
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
                            disabled={coachBusy || !coachEnabled || !botId}
                            style={
                                coachEnabled && botId
                                    ? undefined
                                    : {
                                          background: '#e5e7eb',
                                          color: '#9ca3af',
                                          cursor: 'not-allowed',
                                      }
                            }
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
                <section
                    className="card"
                    style={{ alignSelf: 'flex-start', flex: '0 0 auto', ...liveTranscriptHover.style }}
                    {...liveTranscriptHover.handlers}
                >
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

                    <div
                        className="transcript-list"
                        ref={transcriptListRef}
                        style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 6 }}
                    >
                        {(!botId || (!transcripts.length && !partialTranscript)) && (
                            <div style={{opacity: 0.6, fontSize: 13}}>
                                {botId
                                    ? 'Waiting for the bot to hear some audio.'
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
                                    <div
                                        className="transcript-speaker"
                                        style={{
                                            color: speakerColors[t.speakerName] || '#7a5af8',
                                        }}
                                    >
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
                <section
                    className="card"
                    style={{ alignSelf: 'flex-start', flex: '0 0 auto', ...liveParticipantsHover.style }}
                    {...liveParticipantsHover.handlers}
                >
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

                    <div
                        className="participants-list"
                        style={{ maxHeight: '100vh', overflowY: 'auto', paddingRight: 6 }}
                    >
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
                                <div className="wordshare-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: 6,
                                            fontSize: 13,
                                            color: '#0f172a',
                                        }}
                                    >
                                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                                            <span>
                                                <strong>Total words in call so far:</strong> {totalWordsCount || 0}
                                            </span>
                                            {Number.isFinite(callDurationSec) && (
                                                <span>
                                                    <strong>Call duration:</strong> {formatTimeSec(callDurationSec)}
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div style={{ fontSize: 12, opacity: 0.8 }}>Speaking analytics</div>
                                            <SpeakingViewToggle value={speakingView} onChange={setSpeakingView} />
                                        </div>
                                    </div>

                                    <div>
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

                                    {participation && speakingView === 'ratio' && (
                                        <SpeakingTimeRatio
                                            participation={participation}
                                            title="Speaking-time ratio"
                                            caption="Share of total words in the current call."
                                            colorMap={speakerColors}
                                        />
                                    )}

                                    {participation && speakingView === 'duration' && (
                                        <SpeakingTimeDuration
                                            participation={participation}
                                            title="Speaking time (duration)"
                                            caption="Who actually held the mic (by elapsed speech time)."
                                            colorMap={speakerColors}
                                        />
                                    )}
                                </div>

                                {participation && (
                                    <ParticipationDiagnostics
                                        participation={participation}
                                        mode="live"
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

            <section
                className="card"
                style={{ ...liveTimelineHover.style }}
                {...liveTimelineHover.handlers}
            >
                <div className="card-header">
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Icon name="timeline" size={20} />
                            <h2>Speaking timeline</h2>
                        </div>
                        <span>Per-speaker segments with silence gaps shaded.</span>
                    </div>
                </div>
                <SpeakerTimeline
                    transcripts={transcripts}
                    participation={participation}
                    colorMap={speakerColors}
                />
            </section>

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
        case 'timeline':
            return (
                <svg {...common}>
                    <path d="M3 17h18" />
                    <path d="M5 15v-4l4 2 4-6 5 4v4" />
                    <circle cx="5" cy="11" r="1.5" />
                    <circle cx="9" cy="13" r="1.5" />
                    <circle cx="13" cy="7" r="1.5" />
                    <circle cx="18" cy="11" r="1.5" />
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
                    {p.email ? p.email + ' - ' : ''}
                    {inCall ? 'In call' : 'Not in call'}
                </div>
            </div>

            {isSpeaking && <span className="participant-speaking-tag">speaking</span>}
        </div>
    );
}

function SummarySectionCard({ title, children }) {
    // Render plain text into paragraphs and bullet lists for better readability.
    function renderContent(text) {
        const lines = String(text || '').split(/\r?\n/);
        const parts = [];
        let bullets = [];
        let key = 0;

        const flushBullets = () => {
            if (!bullets.length) return;
            parts.push(
                <ul
                    key={`ul-${key++}`}
                    style={{
                        margin: '0 0 6px 14px',
                        padding: 0,
                        lineHeight: 1.5,
                        color: '#0f172a',
                    }}
                >
                    {bullets.map((b, i) => (
                        <li key={`li-${i}`} style={{ marginBottom: 4 }}>
                            {b}
                        </li>
                    ))}
                </ul>,
            );
            bullets = [];
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                flushBullets();
                continue;
            }

            const bulletMatch = /^[-*]\\s*(.+)$/.exec(trimmed);
            if (bulletMatch) {
                bullets.push(bulletMatch[1]);
                continue;
            }

            flushBullets();
            parts.push(
                <div
                    key={`p-${key++}`}
                    style={{
                        margin: '0 0 6px 0',
                        lineHeight: 1.5,
                        color: '#0f172a',
                    }}
                >
                    {trimmed}
                </div>,
            );
        }

        flushBullets();
        return parts;
    }

    const hover = useHoverCard('medium');

    const content =
        typeof children === 'string' || typeof children === 'number'
            ? renderContent(children)
            : children;

    return (
        <div className="summary-section-card" style={hover.style} {...hover.handlers}>
            <div className="summary-section-title">{title}</div>
            <div className="summary-section-body">{content}</div>
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
                <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
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

/* ---------- Speaking time (duration) ---------- */

function SpeakingTimeDuration({ participation, title, caption, colorMap }) {
    const durations = participation?.speakingTimeSec || {};
    const entries = Object.entries(durations)
        .map(([name, seconds]) => ({
            name,
            seconds: Number.isFinite(seconds) ? seconds : 0,
        }))
        .filter(({ seconds }) => seconds > 0)
        .sort((a, b) => b.seconds - a.seconds);

    if (!entries.length) return null;

    const total = entries.reduce((sum, e) => sum + e.seconds, 0);

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
                <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
                {caption && <div style={{ fontSize: 12, color: '#6b7280' }}>{caption}</div>}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {entries.map(({ name, seconds }) => {
                    const barColor = colorMap?.[name] || '#7a5af8';
                    const share = total > 0 ? seconds / total : 0;
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
                                <span style={{ color: '#6b7280' }}>
                                    {formatTimeSec(seconds)} · {(share * 100).toFixed(0)}%
                                </span>
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
                    );
                })}
            </div>

            <div style={{ fontSize: 12, color: '#475569' }}>
                Total speaking time tracked: {formatTimeSec(total)}
            </div>
        </div>
    );
}

/* ---------- Speaker timeline (per-speaker segments + silences) ---------- */

function SpeakerTimeline({ transcripts, participation, colorMap }) {
    const [tooltip, setTooltip] = useState(null);
    const timelineRef = useRef(null);
    const timed = (transcripts || []).filter((t) =>
        Number.isFinite(t.startSec)
    );

    if (!timed.length) return null;

    const baseStart = Math.min(
        ...timed.map((t) => Number.isFinite(t.startSec) ? t.startSec : Infinity)
    );
    const totalEnd = Math.max(
        ...timed.map((t) => {
            if (Number.isFinite(t.endSec)) return t.endSec;
            if (Number.isFinite(t.startSec)) return t.startSec + 1;
            return 0;
        })
    );
    const span = Math.max(1, totalEnd - baseStart);

    const perSpeaker = {};
    timed.forEach((t) => {
        const speaker = t.speakerName || 'Unknown';
        const start = Number.isFinite(t.startSec) ? t.startSec - baseStart : 0;
        const end = Number.isFinite(t.endSec)
            ? t.endSec - baseStart
            : start + 1;
        const rawDur = Math.max(0, end - start);
        const dur = Math.max(0.5, rawDur);
        const startPct = (start / span) * 100;
        const widthPct = (dur / span) * 100;
        if (!perSpeaker[speaker]) perSpeaker[speaker] = [];
        perSpeaker[speaker].push({
            startPct,
            widthPct: Math.min(100, widthPct),
            hitEndPct: Math.min(100, startPct + (rawDur / span) * 100),
            speaker,
            text:
                typeof t.text === 'string' && t.text.length > 40
                    ? `${t.text.slice(0, 40)}...`
                    : t.text || '',
        });
    });

    const silencePeriods =
        participation?.silence?.periods?.filter(
            (p) =>
                Number.isFinite(p.fromSec) &&
                Number.isFinite(p.toSec) &&
                p.toSec > baseStart &&
                p.fromSec < totalEnd
        ) || [];

    const silenceRanges = silencePeriods.map((p, idx) => {
        const rawFrom = ((p.fromSec - baseStart) / span) * 100;
        const rawTo = ((p.toSec - baseStart) / span) * 100;
        const fromPct = Math.max(0, rawFrom);
        const rawWidth = Math.max(0, rawTo - rawFrom);
        // Match the visual minimum width so hover is reliable.
        const widthPct = Math.max(1, rawWidth);
        const toPct = Math.min(100, fromPct + widthPct);
        return {
            key: `silence-${idx}`,
            fromPct,
            toPct,
            widthPct: Math.min(100, widthPct),
            durationSec: p.durationSec,
        };
    });

    return (
        <div
            style={{
                marginTop: 12,
                padding: 14,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.65)',
                border: '1px solid rgba(255,255,255,0.35)',
                boxShadow: '0 16px 32px rgba(15,23,42,0.08)',
                backdropFilter: 'blur(10px)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                position: 'relative',
            }}
            ref={timelineRef}
        >
            {Object.entries(perSpeaker).map(([name, segments]) => {
                const color = colorMap?.[name] || '#7a5af8';
                return (
                    <div
                        key={name}
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 8,
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: 13,
                                color: '#475569',
                            }}
                        >
                            <span style={{ fontWeight: 600 }}>{name}</span>
                        </div>
                        <div
                            style={{
                                position: 'relative',
                                height: 22,
                                background: '#eef1f8',
                                borderRadius: 999,
                                overflow: 'hidden',
                                boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.2)',
                            }}
                        >
                            {silenceRanges.map((range) => (
                                <div
                                    key={`${name}-${range.key}`}
                                    style={{
                                        position: 'absolute',
                                        left: `${range.fromPct}%`,
                                        width: `${range.widthPct}%`,
                                        top: 0,
                                        bottom: 0,
                                        background: 'linear-gradient(90deg, #e2e8f0, #f8fafc)',
                                        opacity: 0.4,
                                        pointerEvents: 'none',
                                    }}
                                />
                            ))}
                            {segments.map((seg, idx) => (
                                <div
                                    key={`${name}-${idx}`}
                                    style={{
                                        position: 'absolute',
                                        left: `${seg.startPct}%`,
                                        width: `${seg.widthPct}%`,
                                        top: 0,
                                        bottom: 0,
                                        background: color,
                                        opacity: 0.9,
                                        borderRadius: 999,
                                    }}
                                    data-segment="true"
                                    onMouseMove={(e) => {
                                        const rect = timelineRef.current?.getBoundingClientRect();
                                        if (!rect) return;
                                        setTooltip({
                                            x: e.clientX - rect.left + 12,
                                            y: e.clientY - rect.top + 12,
                                            title: seg.speaker || name,
                                            body: seg.text || `${name} speaking`,
                                        });
                                    }}
                                    onMouseLeave={() => setTooltip(null)}
                                />
                            ))}
                        </div>
                    </div>
                );
            })}

            <div style={{ fontSize: 12, color: '#475569' }}>
                Timeline span: {formatTimeSec(span)} (relative to first captured utterance)
            </div>

            {tooltip && tooltip.title !== 'Silence' && (
                <div
                    style={{
                        position: 'absolute',
                        left: tooltip.x,
                        top: tooltip.y,
                        zIndex: 20,
                        pointerEvents: 'none',
                    }}
                >
                    <div
                        style={{
                            background: 'rgba(255,255,255,0.82)',
                            border: '1px solid rgba(229,232,242,0.9)',
                            borderRadius: 12,
                            padding: '8px 10px',
                            color: '#0f172a',
                            fontSize: 13,
                            boxShadow: '0 18px 36px rgba(15,23,42,0.16)',
                            maxWidth: 260,
                            backdropFilter: 'blur(12px)',
                        }}
                    >
                        <div style={{ fontWeight: 600, marginBottom: 2 }}>
                            {tooltip.title}
                        </div>
                        {tooltip.body && (
                            <div style={{ opacity: 0.75 }}>{tooltip.body}</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function SpeakingViewToggle({ value, onChange }) {
    const options = [
        { id: 'ratio', label: 'Words' },
        { id: 'duration', label: 'Time' },
    ];

    return (
        <div
            style={{
                display: 'inline-flex',
                background: '#eef1f8',
                borderRadius: 999,
                padding: 4,
                border: '1px solid rgba(229,232,242,0.8)',
                gap: 4,
            }}
        >
            {options.map((opt) => {
                const active = opt.id === value;
                return (
                    <button
                        key={opt.id}
                        type="button"
                        onClick={() => onChange(opt.id)}
                        style={{
                            border: 'none',
                            padding: '6px 12px',
                            borderRadius: 999,
                            cursor: 'pointer',
                            fontSize: 12,
                            fontWeight: 600,
                            background: active ? '#7a5af8' : 'transparent',
                            color: active ? '#ffffff' : '#475569',
                            boxShadow: active ? '0 8px 18px rgba(122,90,248,0.25)' : 'none',
                            transition: 'all 120ms ease',
                        }}
                    >
                        {opt.label}
                    </button>
                );
            })}
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
        silence = {},
        durationSec,
        balance = { status: 'balanced', reasons: [] },
        interruptionCounts = {},
        turnTakingPerMin,
    } = participation;

    const totalInterruptions = Number.isFinite(interruptions) ? interruptions : 0;
    const topInterrupter = participation.topInterrupter || null;
    const topInterruptionCount = Number.isFinite(participation.topInterruptionCount)
        ? participation.topInterruptionCount
        : null;
    const repetitionSummary = participation.repetitionSummary || {};
    const interruptionList = Object.entries(interruptionCounts)
        .map(([name, count]) => ({
            name,
            count: Number.isFinite(count) ? count : 0,
        }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count);
    const silenceCount = Array.isArray(silence.periods) ? silence.periods.length : 0;
    const totalSilenceSec = Number.isFinite(silence.totalSilenceSec)
        ? silence.totalSilenceSec
        : null;
    const silenceRatio = Number.isFinite(silence.silenceRatio)
        ? silence.silenceRatio
        : null;
    const balanceReasons = Array.isArray(balance.reasons)
        ? balance.reasons.filter(Boolean)
        : [];

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
            <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>

            {dominantSpeaker && dominantShare > 0 ? (
                <div>
                    <strong>Dominant speaker (last few turns):</strong>{' '}
                    {dominantSpeaker} &nbsp;(
                    {(dominantShare * 100).toFixed(0)}% of recent words)
                </div>
            ) : (
                <div>
                    <strong>Dominant speaker (last few turns):</strong> -
                </div>
            )}

            {underrepresented.length > 0 ? (
                <div>
                    <strong>Underrepresented voices:</strong>{' '}
                    {underrepresented
                        .map(
                            (u) =>
                                `${u.name || 'Unknown'} (${(u.share * 100).toFixed(0)}%)`,
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
                        - mostly by {topInterrupter}
                        {topInterruptionCount ? ` (${topInterruptionCount})` : ''}
                    </>
                )}
            </div>

            {interruptionList.length > 0 && (
                <div>
                    <strong>Interruptions by speaker:</strong>
                    <div
                        style={{
                            marginTop: 6,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                        }}
                    >
                        {interruptionList.map((entry) => (
                            <div
                                key={entry.name}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    fontSize: 12,
                                }}
                            >
                                <span style={{ color: '#0f172a' }}>{entry.name}</span>
                                <span
                                    style={{
                                        background: '#eef1f8',
                                        borderRadius: 999,
                                        padding: '2px 8px',
                                        fontWeight: 600,
                                        color: '#475569',
                                    }}
                                >
                                    {entry.count}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div>
                <strong>Turn-taking rate:</strong>{' '}
                {Number.isFinite(turnTakingPerMin)
                    ? `${turnTakingPerMin.toFixed(2)} turns/min`
                    : 'not enough timing data yet'}
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

            {totalSilenceSec !== null ? (
                <div>
                    <strong>Total silence:</strong>{' '}
                    {formatTimeSec(totalSilenceSec)}
                    {silenceRatio !== null && (
                        <> ({(silenceRatio * 100).toFixed(0)}% of call)</>
                    )}
                    {silenceCount > 0 && (
                        <> across {silenceCount} pause{silenceCount === 1 ? '' : 's'}</>
                    )}
                </div>
            ) : (
                <div>
                    <strong>Total silence:</strong> not enough timing data yet
                </div>
            )}

            <div>
                <strong>Dialogue balance:</strong>{' '}
                {balance.status === 'needs_attention' ? 'Needs attention' : 'Balanced'}
                {balanceReasons.length > 0 && <> - {balanceReasons.join('; ')}</>}
            </div>

            {Object.keys(repetitionSummary).length > 0 && (
                <div>
                    <strong>Repetition patterns:</strong>{' '}
                    {Object.entries(repetitionSummary)
                        .map(([name, info]) => {
                            const phrase =
                                (info.phrase || '').length > 40
                                    ? `${info.phrase.slice(0, 40)}...`
                                    : info.phrase || '(short utterance)';
                            return `${name} keeps repeating "${phrase}" (${info.count})`;
                        })
                        .join('; ')}
                </div>
            )}

            <div style={{ opacity: 0.7 }}>
                <strong>Total words in call so far:</strong> {totalWords || 0}
                {Number.isFinite(durationSec) && (
                    <> - <strong>Call duration:</strong> {formatTimeSec(durationSec)}</>
                )}
            </div>
        </div>
    );
}

/* ---------- Summary View "page" ---------- */

function SummaryView({
    botId,
    botState,
    wordCounts,
    pieData,
    onBack,
    speakingView,
    setSpeakingView,
}) {
    const transcripts = botState.transcripts || [];
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

    const totalWordsCount =
        participation?.totalWords ??
        Object.values(wordCounts || {}).reduce((sum, v) => sum + v, 0);
    const callDurationSec = participation?.durationSec ?? null;
    const summaryTranscriptHover = useHoverCard('strong');
    const summaryAnalyticsHover = useHoverCard('strong');
    const summaryTimelineHover = useHoverCard('strong');
    const aiSummaryHover = useHoverCard('strong');

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
                    <button className="button" onClick={onBack} style={{ alignSelf: 'flex-end' }}>
                        Back to console
                    </button>
                </div>
            </header>

            <main className="layout-main layout-main--summary">
                {/* Left: transcript */}
                <section
                    className="card"
                    style={{ alignSelf: 'flex-start', flex: '0 0 auto', ...summaryTranscriptHover.style }}
                    {...summaryTranscriptHover.handlers}
                >
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

                    <div className="transcript-list" style={{ maxHeight: '100vh', overflowY: 'auto', paddingRight: 6 }}>
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
                                    <div
                                        className="transcript-speaker"
                                        style={{
                                            color: speakerColors[t.speakerName] || '#7a5af8',
                                        }}
                                    >
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

                {/* Right: analytics */}
                <section
                    className="card"
                    style={{ alignSelf: 'flex-start', flex: '0 0 auto', ...summaryAnalyticsHover.style }}
                    {...summaryAnalyticsHover.handlers}
                >
                    <div className="card-header">
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Icon name="pie" size={20} />
                                <h2>Speaking analytics</h2>
                            </div>
                            <span>Word counts and participation signals.</span>
                        </div>
                    </div>

                    <div className="wordshare-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 6,
                                fontSize: 13,
                                color: '#0f172a',
                            }}
                        >
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                                <span>
                                    <strong>Total words in call so far:</strong> {totalWordsCount || 0}
                                </span>
                                {Number.isFinite(callDurationSec) && (
                                    <span>
                                        <strong>Call duration:</strong> {formatTimeSec(callDurationSec)}
                                    </span>
                                )}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>Speaking analytics</div>
                                <SpeakingViewToggle value={speakingView} onChange={setSpeakingView} />
                            </div>
                        </div>

                        <div>
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

                        {participation && speakingView === 'ratio' && (
                            <SpeakingTimeRatio
                                participation={participation}
                                title="Speaking-time ratio"
                                caption="Share of total words across the full call."
                                colorMap={speakerColors}
                            />
                        )}

                        {participation && speakingView === 'duration' && (
                            <SpeakingTimeDuration
                                participation={participation}
                                title="Speaking time (duration)"
                                caption="Elapsed speech time per speaker."
                                colorMap={speakerColors}
                            />
                        )}
                    </div>

                    {botState.participation && (
                        <ParticipationDiagnostics
                            participation={botState.participation}
                            mode="summary"
                        />
                    )}
                </section>
            </main>

            <section
                className="card"
                style={summaryTimelineHover.style}
                {...summaryTimelineHover.handlers}
            >
                <div className="card-header">
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Icon name="timeline" size={20} />
                            <h2>Speaking timeline</h2>
                        </div>
                        <span>Per-speaker segments with silence gaps shaded.</span>
                    </div>
                </div>
                <SpeakerTimeline
                    transcripts={transcripts}
                    participation={participation}
                    colorMap={speakerColors}
                />
            </section>

            {/* AI summary card */}
            <section
                className="summary-card"
                style={aiSummaryHover.style}
                {...aiSummaryHover.handlers}
            >
                <div className="summary-card-header">
                    <div className="summary-card-heading">
                        <h2>
                            <Icon name="doc" size={20} />
                            AI summary
                        </h2>
                        <span>
                            Generated from the full transcript and participation signals for quick review.
                        </span>
                    </div>
                    <div className="summary-actions">
                        <span className="summary-badge">
                            {summaryLoading
                                ? 'Refreshing...'
                                : summaryText
                                ? 'Up to date'
                                : 'Needs summary'}
                        </span>
                        <button
                            className="button"
                            type="button"
                            onClick={handleGenerateSummary}
                            disabled={summaryLoading}
                        >
                            <Icon name="doc" />
                            {summaryLoading ? 'Generating ...' : 'Generate / refresh summary'}
                        </button>
                    </div>
                </div>

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
                    <div style={{ marginTop: 4 }}>
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
                            <div className="summary-grid">
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
                            </div>
                        )}

                        {summaryText && !hasStructuredSections && (
                            <div className="summary-grid">
                                <SummarySectionCard title="Summary">
                                    {summaryText}
                                </SummarySectionCard>
                            </div>
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
                        No summary generated yet. Click "Generate / refresh summary"
                        after the call to get a structured recap.
                    </div>
                )}
            </section>
        </div>
    );
}/* ---------- Coach Toast ---------- */

function CoachToast({ message, onClose }) {
    return (
        <div
            style={{
                position: 'fixed',
                top: 16,
                right: 16,
                left: 'auto',
                bottom: 'auto',
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
                            e.currentTarget.style.border = '1px solidrgb(122, 90, 248)';
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








