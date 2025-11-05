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
  OPENAI_CHAT_MODEL = 'gpt-4o',
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
          "translation_en": "string or null - English translations if requested"
        }) + "\n" +
        (translate ? 
          "Incluye translation_en con las traducciones estructuradas así: 'acknowledgment: [traducción del ack_es]\\nreply: [traducción del reply_es]\\nquestion: [traducción del question_es]'" + 
          (translate ? "\\ncorrection: [traducción del correction_es si existe]" : "") :
          "Pon translation_en como null.")
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
    const originalFilename = req.file?.originalname || 'audio.webm';
    const mimetype = req.file?.mimetype || 'audio/webm';

    console.log('STT request received:', {
      hasFile: !!req.file,
      bufferSize: audioBuffer?.length || 0,
      originalFilename: originalFilename,
      mimetype: mimetype
    });

    if (!audioBuffer || audioBuffer.length === 0) {
      console.error('No audio buffer received');
      return res.status(400).json({ error: 'No audio data received' });
    }

    // Use a more compatible filename based on MIME type
    let filename = 'audio.webm'; // Default
    if (mimetype.includes('mp4')) {
      filename = 'audio.mp4';
    } else if (mimetype.includes('wav')) {
      filename = 'audio.wav';
    } else if (mimetype.includes('ogg')) {
      filename = 'audio.ogg';
    }

    console.log('Using filename for OpenAI:', filename);

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: mimetype }), filename);
    form.append('model', OPENAI_STT_MODEL);
    form.append('language', 'es');

    console.log('Sending to OpenAI STT with model:', OPENAI_STT_MODEL);

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: form
    });

    console.log('OpenAI STT response status:', r.status);

    if (!r.ok) {
      const errorText = await r.text();
      console.error('OpenAI STT error details:', {
        status: r.status,
        statusText: r.statusText,
        error: errorText,
        sentFilename: filename,
        sentMimetype: mimetype,
        bufferSize: audioBuffer.length
      });
      return res.status(r.status).send(errorText);
    }
    
    const data = await r.json();
    console.log('OpenAI STT response:', data);
    
    const responseText = data.text || '';
    console.log('Transcribed text:', responseText);
    
    res.json({ text: responseText });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- TRANSLATION: Translate text between languages ----
app.post('/api/translate', async (req, res) => {
  try {
    const { text, from = 'es', to = 'en' } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const systemPrompt = from === 'es' && to === 'en' 
      ? "You are a translator. Translate the given Spanish text to natural English. Only respond with the English translation, nothing else."
      : `You are a translator. Translate the given text from ${from} to ${to}. Only respond with the translation, nothing else.`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        max_tokens: 200,
        temperature: 0.3
      })
    });

    if (!r.ok) {
      console.error('OpenAI API error for translation:', r.status, await r.text());
      return res.status(r.status).send(await r.text());
    }

    const data = await r.json();
    const translation = data.choices?.[0]?.message?.content?.trim() || '';
    
    res.json({ translation });
  } catch (e) {
    console.error('Translation error:', e);
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
