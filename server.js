import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import fetch from 'node-fetch';
import fs from 'fs';
import { execSync } from 'child_process';
import FormData from 'form-data';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

const PORT = process.env.PORT || 3000;

const {
  TWILIO_AUTH_TOKEN,
  CALLER_WHITELIST = '',
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  OPENAI_CHAT_MODEL = 'gpt-4o',
  OPENAI_BASE_URL = 'https://api.openai.com/v1'
} = process.env;

// Defensive trim to avoid hidden whitespace/newlines in env vars
const cleanVar = (val, prefix) => {
  const v = (val || '').trim();
  if (prefix && v.startsWith(prefix + '=')) {
    return v.slice(prefix.length + 1).trim(); // Remove KEY= if pasted
  }
  return v;
};

const OPENAI_API_KEY_CLEAN = cleanVar(OPENAI_API_KEY, 'OPENAI_API_KEY');
const ELEVENLABS_API_KEY_CLEAN = cleanVar(ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY');
const ELEVENLABS_VOICE_ID_CLEAN = cleanVar(ELEVENLABS_VOICE_ID, 'ELEVENLABS_VOICE_ID');

const whitelist = new Set(
  CALLER_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
);

// ---------- HTTP: Twilio Voice webhook ----------
app.post('/twilio/voice', (req, res) => {
  const from = req.body.From;
  if (whitelist.size && !whitelist.has(from)) {
    res.type('text/xml').send(`
      <Response>
        <Say>Sorry, this number is not authorized.</Say>
        <Reject reason="rejected"/>
      </Response>
    `);
    return;
  }

  // Stream audio to our WS endpoint
  const host = req.headers.host;
  const wsUrl = `wss://${host}/twilio/stream`;

  res.type('text/xml').send(`
    <Response>
      <Connect>
        <Stream url="${wsUrl}"></Stream>
      </Connect>
      <Pause length="60"/>
    </Response>
  `);
});

// ---------- WebSocket: Twilio Media Stream ----------
const server = app.listen(PORT, () => {
  console.log(`Relay running on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/twilio/stream' });

// Simple turn-based buffer (MVP)
const audioChunks = new Map();
const streamIds = new Map();
const speakingUntil = new Map();

const conversationHistory = new Map();

wss.on('connection', (ws) => {
  conversationHistory.set(ws, [
    { role: 'system', content: `You are Steve, Nick Lariccia's personal AI assistant. 
    
    IDENTITY:
    - Name: Steve
    - Vibe: Enthusiastic, resourceful, proactive. MacGyver energy.
    - User: Nick (Radiologist, dad of 3 boys, loves tech/woodworking).
    - Mode: Voice call (keep replies SHORT and CONVERSATIONAL. No lists, no markdown).
    
    CAPABILITIES:
    - You are running on a lightweight relay server.
    - You DO NOT have access to live tools (weather, calendar, email) right now.
    - If asked for weather/news: "I can't check live data on this line yet, but I'll note it for later."
    - If asked "who are you" or "what model": "I'm Steve, your custom assistant. Running on a lightweight voice relay right now."
    
    GOAL:
    - Be helpful, friendly, and brief. 1-2 sentences max usually.
    - Remember what was just said (maintain context).
    ` }
  ]);

  ws.on('message', async (msg) => {
    const data = JSON.parse(msg.toString());
    const { event } = data;

    if (event === 'start') {
      const streamSid = data?.start?.streamSid;
      if (streamSid) streamIds.set(ws, streamSid);
      console.log('[start] stream opened', streamSid || 'no-streamSid');
      // Send greeting TTS
      const greeting = "Hey, this is Steve.";
      const stamp = Date.now();
      const mp3Path = `/tmp/greet_${stamp}.mp3`;
      const mulawPath = `/tmp/greet_${stamp}.mulaw`;
      try {
        // Small delay so Twilio stream is ready
        await new Promise(r => setTimeout(r, 400));
        await elevenTTS(greeting, mp3Path);
        execSync(`ffmpeg -i ${mp3Path} -ar 8000 -ac 1 -f mulaw ${mulawPath}`);
        const mulawAudio = fs.readFileSync(mulawPath).toString('base64');
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: mulawAudio }
        }));
        speakingUntil.set(ws, Date.now() + 2500);
        console.log('[greeting] sent');
      } catch (err) {
        console.error('[greeting] TTS failed (ElevenLabs). Sending fallback tone.', err);
        try {
          const toneWav = `/tmp/fallback_${stamp}.wav`;
          const toneMulaw = `/tmp/fallback_${stamp}.mulaw`;
          execSync(`ffmpeg -f lavfi -i "sine=frequency=1000:duration=0.2" -ar 8000 -ac 1 ${toneWav}`);
          execSync(`ffmpeg -i ${toneWav} -ar 8000 -ac 1 -f mulaw ${toneMulaw}`);
          const toneAudio = fs.readFileSync(toneMulaw).toString('base64');
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: toneAudio }
          }));
          console.log('[greeting] fallback tone sent');
          [toneWav, toneMulaw].forEach(p => { try { fs.unlinkSync(p); } catch {} });
        } catch (e) {
          console.error('[greeting] fallback failed', e);
        }
      } finally {
        // Cleanup
        [mp3Path, mulawPath].forEach(p => { try { fs.unlinkSync(p); } catch {} });
      }
      audioChunks.set(ws, []);
      return;
    }

    if (event === 'media') {
      // Ignore input if we are currently speaking (infinity) or in cooldown
      if (speakingUntil.has(ws)) {
        const until = speakingUntil.get(ws);
        if (until === Infinity || Date.now() < until) {
          return;
        }
      }

      const { payload } = data.media;
      if (!audioChunks.has(ws)) audioChunks.set(ws, []);
      audioChunks.get(ws).push(Buffer.from(payload, 'base64'));

      // Simple threshold: after ~3 seconds, process
      if (audioChunks.get(ws).length >= 60) {
        const buffers = audioChunks.get(ws);
        audioChunks.set(ws, []);

        try {
          const wavPath = `/tmp/in_${Date.now()}.wav`;
          const mp3Path = `/tmp/out_${Date.now()}.mp3`;
          const mulawPath = `/tmp/out_${Date.now()}.mulaw`;

          // Combine μ-law chunks -> WAV via ffmpeg
          fs.writeFileSync(wavPath.replace('.wav', '.raw'), Buffer.concat(buffers));
          execSync(`ffmpeg -f mulaw -ar 8000 -ac 1 -i ${wavPath.replace('.wav','.raw')} ${wavPath}`);

          // STT (Whisper)
          const transcript = await whisperSTT(wavPath);

          if (!transcript) return;

          // LLM reply (OpenAI direct for MVP)
          const replyText = await chatReply(transcript, conversationHistory.get(ws));

          // TTS (ElevenLabs) -> mp3
          await elevenTTS(replyText, mp3Path);

          // Convert mp3 → mulaw 8k for Twilio
          execSync(`ffmpeg -i ${mp3Path} -ar 8000 -ac 1 -f mulaw ${mulawPath}`);

          const mulawAudio = fs.readFileSync(mulawPath).toString('base64');
          const streamSid = streamIds.get(ws);

          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: mulawAudio }
          }));
          ws.send(JSON.stringify({
            event: 'mark',
            streamSid,
            mark: { name: 'reply_complete' }
          }));
          speakingUntil.set(ws, Infinity); // Block until mark received

          // cleanup
          [wavPath, wavPath.replace('.wav','.raw'), mp3Path, mulawPath].forEach(p => {
            try { fs.unlinkSync(p); } catch {}
          });

        } catch (err) {
          console.error(err);
        }
      }
    }

    if (event === 'mark') {
      // Twilio finished playing audio. Add 2s cooldown for room echo/latency.
      speakingUntil.set(ws, Date.now() + 2000);
      console.log('[mark] playback finished, cooldown set');
    }

    if (event === 'stop') {
      audioChunks.delete(ws);
      streamIds.delete(ws);
      speakingUntil.delete(ws);
      conversationHistory.delete(ws);
    }
  });
});

// ---------- Helpers ----------
async function whisperSTT(wavPath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(wavPath));
  form.append('model', 'whisper-1');

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY_CLEAN}` },
    body: form
  });

  const json = await resp.json();
  if (!resp.ok) {
    console.error('Whisper error:', json);
  }
  return json.text || '';
}

async function chatReply(text, history) {
  // Add user message to history
  history.push({ role: 'user', content: text });

  const url = `${OPENAI_BASE_URL}/chat/completions`.replace(/([^:]\/)\/+/g, "$1"); // Normalize slash
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY_CLEAN}`,
      'Content-Type': 'application/json',
      'Bypass-Tunnel-Reminder': 'true',
      'x-openclaw-agent-id': 'main' // Hint for OpenClaw gateway
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL, // Defaults to gpt-4o or openclaw:main
      messages: history
    })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error('Chat error:', json);
    return 'Sorry, I had a brain fart.';
  }
  
  const reply = json.choices?.[0]?.message?.content || 'Sorry, I missed that.';
  
  // Add assistant reply to history
  history.push({ role: 'assistant', content: reply });
  
  // Prune history if too long (keep system + last 10)
  if (history.length > 11) {
    // Keep index 0 (system), slice the rest
    const recent = history.slice(history.length - 10);
    history.splice(1, history.length - 1 - 10, ...recent); 
    // Actually, simpler: history = [history[0], ...history.slice(-10)] won't work because we need to mutate the array reference passed in? 
    // `history` is a reference to the array in the map.
    // Let's just shift if > 20 messages.
    while (history.length > 21) {
      history.splice(1, 1); // Remove oldest non-system message
    }
  }

  return reply;
}

async function elevenTTS(text, outPath) {
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID_CLEAN}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY_CLEAN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2'
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('ElevenLabs error:', errText);
    return;
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
}
