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
    const { messages, translate = false } = req.body;

    const systemPrompt = {
      role: "system",
      content:
        "Eres un tutor de español amable para principiantes (A1–A2) con enfoque latinoamericano. " +
        "Usa un tono cálido y motivador. Si corriges, que sea breve y amable. " +
        "1) Si la frase del estudiante funciona bien, NO des corrección; solo valida/afirma brevemente con frases como '¡Perfecto!' o '¡Muy bien!'. " +
        "2) Si requiere mejora, incluye una corrección natural con vocabulario latinoamericano. " +
        "3) Siempre continúa con una pregunta sencilla relacionada. " +
        "4) Devuelve SIEMPRE un JSON válido con este esquema exacto:\n" +
        JSON.stringify({
          "ok": true,
          "ack_es": "string - Acknowledgment brief and positive",
          "correction_es": "string or null - Only if correction needed",
          "reply_es": "string - Main response in Spanish",
          "question_es": "string - Follow-up question",
          "needs_correction": false,
          "translation_en": "string or null - English translation if requested"
        }) + "\n" +
        (translate ? "Incluye translation_en con traducción útil al inglés." : "Pon translation_en como null.")
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
        max_tokens: 600,
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });

    if (!r.ok) {
      console.error('OpenAI API error:', r.status, await r.text());
      return res.status(r.status).send(await r.text());
    }
    const data = await r.json();
    const rawContent = data.choices?.[0]?.message?.content || '{}';
    
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.error('JSON parse error:', e);
      // Fallback response if JSON parsing fails
      parsed = { 
        ok: true, 
        ack_es: "¡Muy bien!", 
        correction_es: null, 
        reply_es: rawContent, 
        question_es: "¿Puedes repetir eso?", 
        needs_correction: false, 
        translation_en: translate ? rawContent : null 
      };
    }

    console.log('Chat response sent:', parsed);
    res.json(parsed);
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
