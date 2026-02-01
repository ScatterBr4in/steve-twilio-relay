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
  OPENAI_CHAT_MODEL = 'gpt-4o-mini'
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

wss.on('connection', (ws) => {
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
          const replyText = await chatReply(transcript);

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

          // cleanup
          [wavPath, wavPath.replace('.wav','.raw'), mp3Path, mulawPath].forEach(p => {
            try { fs.unlinkSync(p); } catch {}
          });

        } catch (err) {
          console.error(err);
        }
      }
    }

    if (event === 'stop') {
      audioChunks.delete(ws);
      streamIds.delete(ws);
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

async function chatReply(text) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY_CLEAN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      messages: [
        { role: 'system', content: 'You are Steve, a helpful assistant. Keep replies concise for phone.' },
        { role: 'user', content: text }
      ]
    })
  });
  const json = await resp.json();
  if (!resp.ok) {
    console.error('Chat error:', json);
  }
  return json.choices?.[0]?.message?.content || 'Sorry, I missed that.';
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
