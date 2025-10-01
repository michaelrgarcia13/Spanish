// server.js — Express backend for chat, STT (Spanish), optional TTS
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fetch from 'node-fetch';

const app = express();
app.use(cors({ origin: true, credentials: false })); // loosen as needed
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage() });

const {
  OPENAI_API_KEY,
  OPENAI_CHAT_MODEL = 'gpt-4o-mini',
  OPENAI_STT_MODEL  = 'whisper-1',
  OPENAI_TTS_MODEL  = 'tts-1',
  OPENAI_TTS_VOICE  = 'alloy'
} = process.env;

// ---- CHAT: Latin-American beginner tutor ----
app.post('/chat', async (req, res) => {
  try {
    console.log('Chat request received:', req.body);
    const { messages } = req.body;

    const systemPrompt = {
      role: "system",
      content:
        "Eres un tutor de español amable para principiantes (A1–A2) con enfoque latinoamericano. " +
        "Responde siempre en español sencillo, claro y breve (2–3 oraciones). " +
        "Primero refuerza lo que el estudiante dijo; luego ofrece una corrección natural al estilo latinoamericano " +
        "con una línea que empiece con 'Corrección:' (usa vocabulario y giros comunes en América Latina). " +
        "Después, continúa la conversación con una pregunta sencilla relacionada. " +
        "Evita explicaciones largas a menos que el estudiante lo pida. " +
        "Si el usuario dice o escribe 'traduce', añade una línea final en inglés con una traducción útil."
    };

    const allMessages = [systemPrompt, ...messages];

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages: allMessages,
        max_tokens: 500,
        temperature: 0.7
      })
    });

    if (!r.ok) {
      console.error('OpenAI API error:', r.status, await r.text());
      return res.status(r.status).send(await r.text());
    }
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    console.log('Chat response sent:', text);
    res.json({ reply: text });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ---- STT: Spanish transcription ----
app.post('/stt', upload.single('audio'), async (req, res) => {
  try {
    const audioBuffer = req.file?.buffer;
    const filename = req.file?.originalname || 'audio.webm';

    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', OPENAI_STT_MODEL);
    form.append('language', 'es');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: form
    });

    if (!r.ok) return res.status(r.status).send(await r.text());
    const data = await r.json();
    res.json({ text: data.text || '' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- TTS: Optional server voice ----
app.post('/tts', async (req, res) => {
  try {
    const { text } = req.body;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: text,
        response_format: 'mp3'
      })
    });

    if (!r.ok) return res.status(r.status).send(await r.text());
    res.setHeader('Content-Type', 'audio/mpeg');
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
