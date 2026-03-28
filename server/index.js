// server/index.js — MeetScribe Bot Server
// Deploy on Render.com — Node.js service

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const BotManager = require('./botManager');
const Transcriber = require('./transcriber');
const SummaryService = require('./summaryService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Active sessions: sessionId → { bot, ws, transcript, metadata }
const sessions = new Map();

// ── WebSocket: client connects here for live transcript stream ──
wss.on('connection', (ws, req) => {
  const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
  console.log(`[WS] Client connected for session: ${sessionId}`);

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.ws = ws;

    // Send existing transcript so far if reconnecting
    if (session.transcript.length > 0) {
      ws.send(JSON.stringify({ type: 'history', data: session.transcript }));
    }
  }

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: ${sessionId}`);
  });
});

// ── Helper: send to client over WebSocket ──
function sendToClient(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (session?.ws?.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify(payload));
  }
}

// ══════════════════════════════════════
// REST API ROUTES
// ══════════════════════════════════════

// POST /api/start — Start a bot for a meeting
app.post('/api/start', async (req, res) => {
  const { meetingUrl, platform, speakers, language } = req.body;

  if (!meetingUrl) {
    return res.status(400).json({ error: 'meetingUrl is required' });
  }

  const sessionId = uuidv4();
  const transcript = [];

  console.log(`[API] Starting bot for: ${meetingUrl}`);

  // Store session immediately
  sessions.set(sessionId, {
    transcript,
    ws: null,
    status: 'starting',
    platform: platform || 'Google Meet',
    speakers: speakers || [],
    language: language || 'en-US',
    startTime: new Date().toISOString(),
    meetingUrl
  });

  res.json({ sessionId, message: 'Bot starting...' });

  // Start bot asynchronously
  try {
    const bot = new BotManager(meetingUrl, platform);
    sessions.get(sessionId).bot = bot;

    sendToClient(sessionId, { type: 'status', status: 'joining', message: 'Bot is joining the meeting...' });

    await bot.join();

    sendToClient(sessionId, { type: 'status', status: 'joined', message: 'Bot joined! Recording started.' });
    sessions.get(sessionId).status = 'recording';

    // Start audio capture + transcription
    const transcriber = new Transcriber(language || 'en-US');
    sessions.get(sessionId).transcriber = transcriber;

    bot.onAudioChunk(async (audioBuffer) => {
      const result = await transcriber.transcribe(audioBuffer);
      if (result?.text?.trim()) {
        const entry = {
          id: uuidv4(),
          text: result.text.trim(),
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: Date.now(),
          speaker: detectSpeaker(result.text, speakers)
        };
        transcript.push(entry);
        sendToClient(sessionId, { type: 'transcript', data: entry });
      }
    });

  } catch (err) {
    console.error('[Bot Error]', err.message);
    sessions.get(sessionId).status = 'error';
    sendToClient(sessionId, { type: 'error', message: err.message });
  }
});

// POST /api/stop — Stop recording
app.post('/api/stop', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    if (session.bot) await session.bot.leave();
    session.status = 'stopped';
    sendToClient(sessionId, { type: 'status', status: 'stopped', message: 'Recording stopped.' });
    res.json({ success: true, wordCount: countWords(session.transcript) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/summary — Generate AI summary
app.post('/api/summary', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    sendToClient(sessionId, { type: 'status', status: 'summarizing', message: 'Generating AI summary...' });
    const summary = await SummaryService.generate(session.transcript, session.speakers);
    sendToClient(sessionId, { type: 'summary', data: summary });
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transcript/:sessionId — Get full transcript
app.get('/api/transcript/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ transcript: session.transcript, status: session.status });
});

// GET /api/sessions — List all sessions
app.get('/api/sessions', (req, res) => {
  const list = [];
  sessions.forEach((s, id) => {
    list.push({
      sessionId: id,
      status: s.status,
      platform: s.platform,
      startTime: s.startTime,
      words: countWords(s.transcript),
      segments: s.transcript.length
    });
  });
  res.json(list.reverse());
});

// GET /api/health — Health check for Render
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, uptime: process.uptime() });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Helpers ──
function detectSpeaker(text, speakers) {
  // Basic round-robin speaker detection (upgrade with audio fingerprinting later)
  if (!speakers || speakers.length === 0) return 'Speaker';
  return speakers[Math.floor(Math.random() * speakers.length)];
}

function countWords(transcript) {
  return transcript.reduce((acc, e) => acc + (e.text?.split(' ').length || 0), 0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ MeetScribe Bot Server running on port ${PORT}`);
});
