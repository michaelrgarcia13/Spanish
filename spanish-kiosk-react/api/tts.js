// api/tts.js — Vercel serverless function for text-to-speech
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'tts-1',
        voice: process.env.OPENAI_TTS_VOICE || 'alloy',
        input: text,
        response_format: 'mp3'
      })
    });

    if (!r.ok) {
      const errorText = await r.text();
      console.error('OpenAI TTS error:', r.status, errorText);
      return res.status(r.status).send(errorText);
    }

    // Stream the audio response
    const audioBuffer = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.byteLength);
    res.setHeader('Content-Disposition', 'inline; filename="speech.mp3"');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(audioBuffer));

  } catch (e) {
    console.error('TTS error:', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
