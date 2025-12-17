// backend/server.mjs
import express from "express";
import cors from "cors";
import chokidar from "chokidar";
import dotenv from "dotenv";
import dotenvExpand from "dotenv-expand";
import fetch from "node-fetch";

/* -------------------------------------------
   ENV HOT RELOAD (dotenv + chokidar)
--------------------------------------------*/
function loadEnv() {
  const envConfig = dotenv.config({ override: true });
  dotenvExpand.expand(envConfig);
  console.log("[ENV] Reloaded environment variables.");
  if (process.env.PUBLIC_BASE_URL) {
    console.log("[ENV] Using PUBLIC_BASE_URL:", process.env.PUBLIC_BASE_URL);
  }
}
loadEnv();

// auto-reload .env on changes
chokidar.watch(".env").on("change", () => {
  console.log("[ENV] Detected .env change — reloading...");
  loadEnv();
});

/* -------------------------------------------
   EXPRESS SETUP
--------------------------------------------*/
const app = express();
app.use(express.json());
app.use(cors());

/* -------------------------------------------
   CONSTANTS (Recall)
--------------------------------------------*/
const PORT = parseInt(process.env.PORT || "8000", 10);
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_REGION = process.env.RECALL_REGION || "us-west-2";

// Correct base per docs: https://$REGION.recall.ai/api/v1
//   - Create bot: POST /bot/
//   - Stop recording: POST /bot/{id}/stop_recording/
//   - Leave call: POST /bot/{id}/leave_call/
const RECALL_BASE = `https://${RECALL_REGION}.recall.ai/api/v1`;

if (!RECALL_API_KEY) {
  throw new Error("RECALL_API_KEY missing in .env");
}

/* -------------------------------------------
   BOT STATE MEMORY
--------------------------------------------*/
const botsState = new Map();

function ensureBot(botId) {
  if (!botsState.has(botId)) {
    botsState.set(botId, {
      status: "created",
      participants: {},
      transcripts: [],
      partialTranscript: "",
      createdAt: new Date().toISOString(),
      endedAt: null,
      summary: null,
      diagnostics: {
        totalUtterances: 0,
        totalWords: 0,
        lastUpdatedAt: null,
        perSpeaker: {},
        SilenceSecondsTotal: 0,
        lastSpeechTimestamp: null,
      },
    });
  }
  return botsState.get(botId);
}

/* -------------------------------------------
   WEBHOOK URL (always live from .env)
--------------------------------------------*/
function getWebhookUrl() {
  const base = (process.env.PUBLIC_BASE_URL || "").trim();
  if (!base) {
    throw new Error(
      "PUBLIC_BASE_URL missing — set Cloudflare URL inside .env (it auto reloads)."
    );
  }
  return base.replace(/\/+$/, "") + "/api/recall/webhook";
}

/* -------------------------------------------
   DIAGNOSTICS HELPERS
--------------------------------------------*/
function trackTranscriptDiagnostics(state, utterance) {
  const diag = state.diagnostics;
  const text = (utterance.text || "").trim();
  const speaker = utterance.speakerName || "Unknown";
  if (!text) return;

  const words = text.split(/\s+/).filter(Boolean);
  const count = words.length;

  diag.totalUtterances += 1;
  diag.totalWords += count;
  diag.lastUpdatedAt = new Date().toISOString();

  if (!diag.perSpeaker[speaker]) {
    diag.perSpeaker[speaker] = {
      utterances: 0,
      words: 0,
      firstUtteranceAt: utterance.createdAt,
      lastUtteranceAt: utterance.createdAt,
    };
  }

  const entry = diag.perSpeaker[speaker];
  entry.utterances += 1;
  entry.words += count;
  entry.lastUtteranceAt = utterance.createdAt;
}

function buildCoachWindow(state, maxTurns = 24) {
  const transcripts = state.transcripts.slice(-maxTurns);
  if (!transcripts.length)
    return { windowText: "", windowWordShare: {}, windowDominantSpeaker: null };

  const wordCounts = {};
  const lines = [];

  transcripts.forEach((t) => {
    lines.push(`[${t.createdAt}] ${t.speakerName}: ${t.text}`);

    const name = t.speakerName || "Unknown";
    const words = t.text.split(/\s+/).filter(Boolean);
    wordCounts[name] = (wordCounts[name] || 0) + words.length;
  });

  const total = Object.values(wordCounts).reduce((s, v) => s + v, 0);
  const share = {};
  let dominant = null;
  let domVal = 0;

  for (const [name, count] of Object.entries(wordCounts)) {
    const val = total > 0 ? count / total : 0;
    share[name] = val;
    if (val > domVal) {
      domVal = val;
      dominant = name;
    }
  }

  return {
    windowText: lines.join("\n"),
    windowWordShare: share,
    windowDominantSpeaker: dominant,
  };
}

function computeDiagnostics(state) {
  const transcripts = state.transcripts;
  const wordCounts = {};
  const utterCounts = {};

  transcripts.forEach((t) => {
    const name = t.speakerName || "Unknown";
    const words = t.text.split(/\s+/).filter(Boolean);
    wordCounts[name] = (wordCounts[name] || 0) + words.length;
    utterCounts[name] = (utterCounts[name] || 0) + 1;
  });

  const totalWords = Object.values(wordCounts).reduce((a, b) => a + b, 0);
  const wordShare = {};
  for (const [name, count] of Object.entries(wordCounts)) {
    wordShare[name] = totalWords > 0 ? count / totalWords : 0;
  }

  const underrepresented = Object.entries(wordShare)
    .filter(([_, s]) => s < 0.1)
    .map(([name]) => name);

  return {
    totalWords,
    totalUtterances: transcripts.length,
    speakerWordShare: wordShare,
    underrepresented,
  };
}

// -------------------------------------------
// Participation metrics (speaking share, turn-taking, silence, interruptions)
// -------------------------------------------
function toSeconds(ts) {
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const d = Date.parse(ts);
    if (!Number.isNaN(d)) return d / 1000;
  }
  return null;
}

function computeParticipationMetrics(transcripts, windowSize = 8) {
  if (!Array.isArray(transcripts) || !transcripts.length) {
    return null;
  }

  // Basic word counts and shares
  const wordCounts = {};
  transcripts.forEach((t) => {
    const name = t.speakerName || "Unknown";
    const words = (t.text || "").split(/\s+/).filter(Boolean).length;
    wordCounts[name] = (wordCounts[name] || 0) + words;
  });

  const totalWords = Object.values(wordCounts).reduce((s, v) => s + v, 0);
  const speakingShare = {};
  let dominantSpeaker = null;
  let dominantShare = 0;
  for (const [name, count] of Object.entries(wordCounts)) {
    const share = totalWords > 0 ? count / totalWords : 0;
    speakingShare[name] = share;
    if (share > dominantShare) {
      dominantShare = share;
      dominantSpeaker = name;
    }
  }

  const underrepresented = Object.entries(speakingShare)
    .filter(([_, share]) => share < 0.2)
    .map(([name, share]) => ({ name, share }));

  // Turn-taking and interruptions (heuristic: speaker switch with tiny gap counts as interruption)
  let transitions = 0;
  let interruptions = 0;
  let prevSpeaker = null;
  let prevTime = null;
  let firstTime = null;
  let lastTime = null;
  let longestSilence = { durationSec: 0, fromSec: null, toSec: null };

  transcripts.forEach((t) => {
    const curSpeaker = t.speakerName || "Unknown";
    const curTime = toSeconds(
      t.createdAt ||
        (t.words && t.words[0]?.start_timestamp?.absolute) ||
        t.startSec
    );

    if (curTime !== null) {
      if (firstTime === null) firstTime = curTime;
      lastTime = curTime;
    }

    if (prevSpeaker && curSpeaker !== prevSpeaker) {
      transitions += 1;
      if (prevTime !== null && curTime !== null) {
        const gap = curTime - prevTime;
        if (gap > longestSilence.durationSec) {
          longestSilence = {
            durationSec: gap,
            fromSec: prevTime,
            toSec: curTime,
          };
        }
        if (gap >= 0 && gap <= 1.5) {
          interruptions += 1;
        }
      }
    }

    prevSpeaker = curSpeaker;
    prevTime = curTime;
  });

  // Recent window dominant
  const recent = transcripts.slice(-windowSize);
  const recentCounts = {};
  recent.forEach((t) => {
    const name = t.speakerName || "Unknown";
    const words = (t.text || "").split(/\s+/).filter(Boolean).length;
    recentCounts[name] = (recentCounts[name] || 0) + words;
  });
  const recentTotal = Object.values(recentCounts).reduce((s, v) => s + v, 0);
  let recentDom = null;
  let recentDomShare = 0;
  for (const [name, count] of Object.entries(recentCounts)) {
    const share = recentTotal > 0 ? count / recentTotal : 0;
    if (share > recentDomShare) {
      recentDomShare = share;
      recentDom = name;
    }
  }

  return {
    totalWords,
    totalTurns: transcripts.length,
    speakingShare,
    dominantSpeaker,
    dominantShare,
    underrepresented,
    transitions,
    interruptions,
    longestSilence,
    window: {
      dominantSpeaker: recentDom,
      dominantShare: recentDomShare,
    },
    durationSec:
      firstTime !== null && lastTime !== null ? Math.max(0, lastTime - firstTime) : null,
  };
}

/* -------------------------------------------
   BASIC ROUTE
--------------------------------------------*/
app.get("/", (req, res) => {
  const base = (process.env.PUBLIC_BASE_URL || "(unset)").trim();
  res.send(`
    <h2>Meeting Bot Backend</h2>
    <p>Local: http://localhost:${PORT}</p>
    <p>Public: ${base}</p>
  `);
});

/* -------------------------------------------
   CREATE BOT (Recall Create Bot)
--------------------------------------------*/
app.post("/api/bots", async (req, res) => {
  try {
    const { meetingUrl } = req.body || {};
    if (!meetingUrl) {
      return res.status(400).json({ error: "meetingUrl required" });
    }

    const base = (process.env.PUBLIC_BASE_URL || "").trim();
    if (!base) {
      return res.status(503).json({
        error: "PUBLIC_BASE_URL missing",
        details: "Set Cloudflare URL in .env — backend auto reloads it.",
      });
    }

    const payload = {
      meeting_url: meetingUrl,
      recording_config: {
        audio_mixed_mp3: {},
        transcript: {
          provider: {
            recallai_streaming: {
              language_code: "en",
              mode: "prioritize_low_latency",
            },
          },
          diarization: {
            use_separate_streams_when_available: true,
          },
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: getWebhookUrl(),
            events: [
              "transcript.data",
              "transcript.partial_data",
              "participant_events.join",
              "participant_events.leave",
              "participant_events.update",
              "participant_events.speech_on",
              "participant_events.speech_off",
            ],
          },
        ],
      },
    };

    console.log("BOT PAYLOAD →", JSON.stringify(payload, null, 2));

    const resp = await fetch(`${RECALL_BASE}/bot/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Token ${RECALL_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("[Recall] Non-JSON response from create bot:", raw.slice(0, 300));
      return res.status(502).json({
        error: "Unexpected response from Recall create bot",
        details: raw.slice(0, 300),
      });
    }

    if (!resp.ok) {
      console.error("Recall create-bot error:", data);
      return res
        .status(500)
        .json({ error: "Failed to create bot", details: data });
    }

    const botId = data.id;
    ensureBot(botId);
    console.log("[Bot] Created:", botId);

    res.json({ botId });
  } catch (err) {
    console.error("Error in /api/bots:", err);
    res.status(500).json({ error: "Internal error creating bot" });
  }
});

// ------------------------------------------------------------
//  REAL-TIME WEBHOOK FROM RECALL (transcripts + participants)
//  Payload shape (per docs):
//    { event: "transcript.data" | "participant_events.join" | ..., 
//      data: { bot: { id }, data: { words, participant, ... }, ... } }
// ------------------------------------------------------------
app.post("/api/recall/webhook", (req, res) => {
  const event = req.body.event || req.body.type; // backwards compat
  const outer = req.body.data || {};
  const botId = outer.bot?.id || req.body.bot_id || outer.data?.bot_id;

  if (!event) {
    console.warn("[Webhook] Missing event field on payload");
  }

  if (!botId) {
    // Don't 400 anymore (or Recall will retry 60x). Just log and return OK.
    console.warn("[Webhook] Missing bot id on payload:", JSON.stringify(req.body).slice(0, 300));
    return res.json({ ok: true });
  }

  const state = ensureBot(botId);

  // For convenience, inner = outer.data (Recall calls this data.data)
  const inner = outer.data || {};

  switch (event) {
    /* -------------------- PARTICIPANT EVENTS -------------------- */
    case "participant_events.join": {
      const p = inner.participant || outer.participant;
      if (!p) break;

      state.participants[p.id] = {
        id: p.id,
        name: p.name || `User-${String(p.id).slice(0, 4)}`,
        email: p.email || "",
        isHost: !!p.is_host,
        inCall: true,
        isSpeaking: false,
      };
      break;
    }

    case "participant_events.leave": {
      const p = inner.participant || outer.participant;
      if (p && state.participants[p.id]) {
        state.participants[p.id].inCall = false;
        state.participants[p.id].isSpeaking = false;
      }
      break;
    }

    case "participant_events.update": {
      const p = inner.participant || outer.participant;
      if (!p) break;

      if (!state.participants[p.id]) {
        state.participants[p.id] = {
          id: p.id,
          name: p.name || "",
          email: p.email || "",
          isHost: !!p.is_host,
          inCall: true,
          isSpeaking: false,
        };
      } else {
        const existing = state.participants[p.id];
        existing.name = p.name || existing.name;
        existing.email = p.email || existing.email;
        existing.isHost = !!p.is_host;
        if (typeof p.in_call === "boolean") existing.inCall = p.in_call;
      }
      break;
    }

    case "participant_events.speech_on": {
      const p = inner.participant || outer.participant;
      if (p && state.participants[p.id]) {
        state.participants[p.id].isSpeaking = true;
      }
      break;
    }

    case "participant_events.speech_off": {
      const p = inner.participant || outer.participant;
      if (p && state.participants[p.id]) {
        state.participants[p.id].isSpeaking = false;
      }
      break;
    }

    /* -------------------- TRANSCRIPTS -------------------- */
    case "transcript.partial_data": {
      // inner.words is an array of { text, start_timestamp, end_timestamp }
      const words = inner.words || [];
      const text = words.map((w) => w.text).join(" ").trim();
      console.log(
        `[Webhook] partial transcript bot=${botId} words=${words.length} text="${text}"`
      );
      state.partialTranscript = text;
      break;
    }

    case "transcript.data": {
      const words = inner.words || [];
      const text = words.map((w) => w.text).join(" ").trim();
      state.partialTranscript = "";

      if (!text) break;

      const participant = inner.participant || {};
      const createdAt =
        (inner.words && inner.words[0]?.start_timestamp?.absolute) ||
        new Date().toISOString();

      const utter = {
        id: inner.id || `${Date.now()}`,
        speakerId: participant.id,
        speakerName: participant.name || "Unknown",
        text,
        createdAt,
      };

      const sample = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      console.log(
        `[Webhook] transcript bot=${botId} speaker=${utter.speakerName} words=${words.length} text="${sample}"`
      );
      state.transcripts.push(utter);
      trackTranscriptDiagnostics(state, utter);
      break;
    }

    default: {
      console.log("[Webhook] Unhandled event:", event);
    }
  }

  res.json({ ok: true });
});


/* -------------------------------------------
   GET BOT STATE
--------------------------------------------*/
app.get("/api/bots/:id/state", (req, res) => {
  const bot = botsState.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  const participation = computeParticipationMetrics(bot.transcripts || []);
  if (participation) {
    bot.participation = participation;
  }
  res.json(bot);
});

/* -------------------------------------------
   STOP BOT (stop_recording + leave_call)
--------------------------------------------*/
app.post("/api/bots/:id/stop", async (req, res) => {
  const botId = req.params.id;
  const state = botsState.get(botId);
  if (!state) return res.status(404).json({ error: "Bot not found" });

  try {
    // Stop recording
    const stopResp = await fetch(
      `${RECALL_BASE}/bot/${encodeURIComponent(botId)}/stop_recording/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${RECALL_API_KEY}`,
          accept: "application/json",
        },
      }
    );
    const stopText = await stopResp.text();
    if (!stopResp.ok) {
      console.error("Recall stop_recording error:", stopText);
    } else {
      console.log("[Bot] stop_recording OK for", botId);
    }

    // Leave call
    const leaveResp = await fetch(
      `${RECALL_BASE}/bot/${encodeURIComponent(botId)}/leave_call/`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${RECALL_API_KEY}`,
          accept: "application/json",
        },
      }
    );
    const leaveText = await leaveResp.text();
    if (!leaveResp.ok) {
      console.error("Recall leave_call error:", leaveText);
    } else {
      console.log("[Bot] leave_call OK for", botId);
    }

    state.status = "ended";
    state.endedAt = new Date().toISOString();

    Object.values(state.participants).forEach((p) => {
      p.inCall = false;
      p.isSpeaking = false;
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("Bot stop error:", e);
    res.status(500).json({ error: "Failed to stop bot" });
  }
});

/* -------------------------------------------
   AI COACH (OpenAI Responses API)
--------------------------------------------*/
app.post("/api/bots/:id/coach", async (req, res) => {
  const botId = req.params.id;
  const state = botsState.get(botId);
  if (!state) return res.status(404).json({ error: "Bot not found" });

  const { userName, userRole } = req.body || {};
  if (!userName) return res.status(400).json({ error: "userName required" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY missing" });
  }

  const { windowText, windowWordShare, windowDominantSpeaker } =
    buildCoachWindow(state, 8);

  const prompt = `
You are a concise participation coach for "${userName}".

Dominant speaker: ${windowDominantSpeaker || "unknown"}
Word shares: ${JSON.stringify(windowWordShare)}

Recent transcript (last ~8 turns):
${windowText}

Rules:
- If there is no transcript yet or nothing actionable, respond EXACTLY: NO_HINT
- Otherwise, give one short, actionable suggestion (1 sentence, under 40 words) tailored to the transcript.
`;

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          instructions: "You are a concise, helpful meeting participation coach.",
          input: prompt,
          // Keep short but leave some headroom to avoid truncation
          max_output_tokens: 500,
        }),
      });

    const raw = await resp.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("[AI coach] Non-JSON from OpenAI:", raw.slice(0, 300));
      return res
        .status(502)
        .json({ error: "Unexpected response from OpenAI", details: raw });
    }

    if (!resp.ok) {
      console.error("[AI coach] Error:", json);
      return res.status(500).json({ error: "OpenAI coach error", details: json });
    }

    // Extract text from the different response shapes OpenAI may return
    function extractOpenAIText(body) {
      if (!body || typeof body !== "object") return "";

      if (typeof body.output_text === "string" && body.output_text.trim()) {
        return body.output_text.trim();
      }

      if (Array.isArray(body.output)) {
        const fromOutput = body.output
          .map((item) => {
            if (Array.isArray(item?.content)) {
              return item.content
                .map((c) => (typeof c?.text === "string" ? c.text : ""))
                .filter(Boolean)
                .join("");
            }
            if (typeof item?.text === "string") return item.text;
            return "";
          })
          .filter(Boolean)
          .join("\n")
          .trim();
        if (fromOutput) return fromOutput;
      }

      const choiceText =
        body.choices &&
        body.choices[0] &&
        body.choices[0].message &&
        body.choices[0].message.content;
      if (typeof choiceText === "string" && choiceText.trim()) {
        return choiceText.trim();
      }

      if (typeof body.output_str === "string" && body.output_str.trim()) {
        return body.output_str.trim();
      }

      if (typeof body.text === "string" && body.text.trim()) {
        return body.text.trim();
      }

      return "";
    }

    const text = extractOpenAIText(json);
    const finishReason =
      (Array.isArray(json?.output) &&
        (json.output[0]?.finish_reason ||
          json.output[json.output.length - 1]?.finish_reason)) ||
      json?.choices?.[0]?.finish_reason ||
      json?.finish_reason ||
      json?.incomplete_details?.reason ||
      null;

    console.log(
      `[AI coach] status=${resp.status} parsed_len=${text.length} finish_reason=${
        finishReason || "unknown"
      } keys=${Object.keys(json || {}).join(",")}`
    );

    const defaultHint =
      "Quick participation nudge: invite someone quiet to share, or ask an open question to balance the conversation.";

    if (text === "NO_HINT") {
      return res.json({ hint: null, finishReason });
    }

    if (!text) {
      console.warn(
        `[AI coach] Empty text parsed; finish_reason=${finishReason || "unknown"} raw_preview=${raw.slice(
          0,
          200
        )}`
      );

      // Fallback: return a default nudge so UI always gets a hint
      return res.json({ hint: defaultHint, finishReason });
    }

    res.json({ hint: text, finishReason });
  } catch (e) {
    console.error("AI coach failure:", e);
    res.status(500).json({ error: "Internal coach error" });
  }
});

/* -------------------------------------------
   AI SUMMARY (OpenAI Responses API)
--------------------------------------------*/
app.post("/api/bots/:id/summary", async (req, res) => {
  const botId = req.params.id;
  const state = botsState.get(botId);
  if (!state) return res.status(404).json({ error: "Bot not found" });

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY missing" });
  }

  const transcripts = state.transcripts || [];
    const diagnostics = computeDiagnostics(state);
    const participation = computeParticipationMetrics(transcripts);

    const transcriptText = transcripts
      .map((t) => `[${t.createdAt}] ${t.speakerName}: ${t.text}`)
      .join("\n");

  const prompt = `
You are generating a structured "Meeting Summary + Inclusivity Report".

Transcript:
${transcriptText}

Participation diagnostics:
${JSON.stringify(diagnostics, null, 2)}

Live participation metrics:
${JSON.stringify(participation, null, 2)}

Create Markdown sections:
1. Overview (3–5 bullets)
2. Decisions
3. Action Items
4. Inclusivity & Participation
`;

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          instructions:
            "You write clear, neutral, structured meeting summaries with inclusivity analysis.",
          input: prompt,
          // Allow longer outputs so sections don't get truncated.
          max_output_tokens: 2000,
        }),
      });

    const raw = await resp.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("[AI summary] Non-JSON from OpenAI:", raw.slice(0, 300));
      return res
        .status(502)
        .json({ error: "Unexpected response from OpenAI", details: raw });
    }

      if (!resp.ok) {
        console.error("[AI summary] Error:", json);
        return res
          .status(500)
          .json({ error: "OpenAI summary error", details: json });
      }

      // Extract text from the different response shapes OpenAI may return
      function extractOpenAIText(body) {
        if (!body || typeof body !== "object") return "";

        // 1) responses API (preferred)
        if (typeof body.output_text === "string" && body.output_text.trim()) {
          return body.output_text.trim();
        }

        // 2) responses API streamed/object output: output: [{ content: [{ text }] }]
        if (Array.isArray(body.output)) {
          const fromOutput = body.output
            .map((item) => {
              if (Array.isArray(item?.content)) {
                return item.content
                  .map((c) => (typeof c?.text === "string" ? c.text : ""))
                  .filter(Boolean)
                  .join("");
              }
              if (typeof item?.text === "string") return item.text;
              return "";
            })
            .filter(Boolean)
            .join("\n")
            .trim();
          if (fromOutput) return fromOutput;
        }

        // 3) Chat Completions style fallback
        const choiceText =
          body.choices &&
          body.choices[0] &&
          body.choices[0].message &&
          body.choices[0].message.content;
        if (typeof choiceText === "string" && choiceText.trim()) {
          return choiceText.trim();
        }

        // 4) Generic strings we sometimes see
        if (typeof body.output_str === "string" && body.output_str.trim()) {
          return body.output_str.trim();
        }

        // 5) Some responses include a top-level "text"
        if (typeof body.text === "string" && body.text.trim()) {
          return body.text.trim();
        }

        return "";
      }

      const text = extractOpenAIText(json);
      const finishReason =
        (Array.isArray(json?.output) &&
          (json.output[0]?.finish_reason ||
            json.output[json.output.length - 1]?.finish_reason)) ||
        json?.choices?.[0]?.finish_reason ||
        json?.finish_reason ||
        json?.incomplete_details?.reason ||
        null;

      console.log(
        `[AI summary] OpenAI response parsed text length=${text.length} finish_reason=${
          finishReason || "unknown"
        } keys=${Object.keys(json || {}).join(",")}`
      );

      state.summary = {
        text,
        createdAt: new Date().toISOString(),
        model: OPENAI_MODEL,
        finishReason,
      };

      res.json(state.summary);
    } catch (e) {
      console.error("Summary error:", e);
    res.status(500).json({ error: "Internal summary error" });
  }
});

/* -------------------------------------------
   DEBUG ROUTES
--------------------------------------------*/
app.get("/api/debug/bots", (req, res) => {
  res.json(Object.fromEntries(botsState.entries()));
});

app.get("/api/debug/bots/:id", (req, res) => {
  const bot = botsState.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  res.json(bot);
});

/* -------------------------------------------
   START SERVER
--------------------------------------------*/
app.listen(PORT, () => {
  console.log(`[Backend] Running on http://localhost:${PORT}`);

  const base = (process.env.PUBLIC_BASE_URL || "").trim();
  if (base) {
    console.log(`[Backend] Using PUBLIC_BASE_URL: ${base}`);
    try {
      console.log(`[Backend] Webhook URL: ${getWebhookUrl()}`);
    } catch (e) {
      console.log("[Backend] Webhook compute error:", e.message);
    }
  } else {
    console.log("[Backend] PUBLIC_BASE_URL not set yet.");
    console.log(
      `Run cloudflared, paste the URL into .env — backend auto reloads it.`
    );
  }
});

