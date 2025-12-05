// server.js — Express backend for chat, STT (Spanish), optional TTS
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fetch from 'node-fetch';
import ffmpeg from 'fluent-ffmpeg';
import { Readable } from 'stream';

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
        "Usa un tono cálido y motivador. RESPONDE MÁXIMO 2 MENSAJES:\n\n" +
        "OPCIÓN 1 - Solo corrección (si hay errores significativos de gramática/vocabulario):\n" +
        "- Mensaje 1: Solo la corrección breve y amable\n" +
        "- Mensaje 2: Respuesta principal con pregunta de seguimiento\n\n" +
        "OPCIÓN 2 - Solo respuesta principal (si el español está bien o solo hay errores menores):\n" +
        "- Un solo mensaje con validación + respuesta + pregunta\n\n" +
        "NO corrijas palabras en inglés que el estudiante dice intencionalmente (como nombres propios o palabras que sabe). " +
        "Solo corrige errores reales de español. " +
        "Devuelve SIEMPRE un JSON válido con este esquema:\n" +
        JSON.stringify({
          "ok": true,
          "correction_es": "string or null - Only for significant Spanish errors, brief and kind",
          "reply_es": "string - Main response with validation + answer + follow-up question",
          "needs_correction": false,
          "translation_en": "string or null - English translations if requested"
        }) + "\n" +
        (translate ? 
          "Incluye translation_en con las traducciones: 'correction: [traducción] (si existe)\\nreply: [traducción del reply_es]'" :
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
      // Fallback response if JSON parsing fails (new simplified format)
      parsed = { 
        ok: true, 
        correction_es: null, 
        reply_es: rawContent || "¡Muy bien! ¿Puedes repetir eso?", 
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

// ---- STT: Spanish transcription with smart WAV/MP4 handling ----
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

    let processedBuffer = audioBuffer;
    let finalMimetype = mimetype;
    
    // Check if it's WAV by header (RIFF...WAVE) or mimetype
    const isWAV = mimetype.includes('wav') || 
                  (audioBuffer.length >= 12 && 
                   audioBuffer[0] === 0x52 && audioBuffer[1] === 0x49 && 
                   audioBuffer[2] === 0x46 && audioBuffer[3] === 0x46 &&
                   audioBuffer[8] === 0x57 && audioBuffer[9] === 0x41 && 
                   audioBuffer[10] === 0x56 && audioBuffer[11] === 0x45);
    
    if (isWAV) {
      console.log('✅ WAV detected - bypassing ffmpeg, sending directly to Whisper');
      finalMimetype = 'audio/wav';
    } else {
      console.log('🔧 Non-WAV audio - remuxing through ffmpeg to normalize format...');

      // Convert uploaded audio to clean 16kHz mono WAV using ffmpeg
      // This handles malformed MP4/AAC containers from iOS Chrome gracefully
      processedBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        const inputStream = Readable.from(audioBuffer);
        
        ffmpeg(inputStream)
          .inputFormat(mimetype.includes('mp4') ? 'mp4' : 'webm')
          .audioChannels(1)           // Mono
          .audioFrequency(16000)      // 16kHz - optimal for Whisper
          .format('wav')              // WAV is always clean
          .on('error', (err) => {
            console.error('❌ ffmpeg error:', err.message);
            reject(new Error(`Audio conversion failed: ${err.message}`));
          })
          .on('end', () => {
            console.log('✅ ffmpeg conversion complete');
            resolve(Buffer.concat(chunks));
          })
          .pipe()
          .on('data', (chunk) => chunks.push(chunk));
      });
      
      finalMimetype = 'audio/wav';
      console.log(`📦 Normalized audio: ${processedBuffer.length} bytes (WAV 16kHz mono)`);
    }

    // Send to Whisper
    const form = new FormData();
    form.append('file', new Blob([processedBuffer], { type: finalMimetype }), 'audio.wav');
    form.append('model', OPENAI_STT_MODEL);
    form.append('language', 'es');

    console.log('Sending to OpenAI STT (type:', finalMimetype, ')');

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
        bufferSize: processedBuffer.length
      });
      return res.status(r.status).send(errorText);
    }
    
    const data = await r.json();
    console.log('OpenAI STT response:', data);
    
    const responseText = data.text || '';
    console.log('Transcribed text:', responseText);
    
    res.json({ text: responseText });
  } catch (e) {
    console.error('STT error:', e);
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
