// api/stt.js — Vercel serverless function for speech-to-text (raw audio body)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const contentType = req.headers['content-type'] || '';
    
    // Validate Content-Type
    if (!contentType.includes('audio/')) {
      return res.status(400).json({ error: 'Content-Type must be audio/wav, audio/mp4, audio/webm, etc.' });
    }

    // Read raw body as buffer
    const audioBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    if (audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio data' });
    }

    console.log(`STT request: ${audioBuffer.length} bytes, Content-Type: ${contentType}`);

    // Determine file extension from Content-Type
    let extension = 'wav';
    if (contentType.includes('mp4')) extension = 'mp4';
    else if (contentType.includes('webm')) extension = 'webm';
    else if (contentType.includes('ogg')) extension = 'ogg';

    // Create FormData for OpenAI (using global FormData in Vercel runtime)
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: contentType });
    formData.append('file', audioBlob, `audio.${extension}`);
    formData.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
    formData.append('language', 'es');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData
    });

    if (!r.ok) {
      const errorText = await r.text();
      console.error('OpenAI STT error:', r.status, errorText);
      return res.status(r.status).json({ error: errorText });
    }

    const data = await r.json();
    console.log(`STT success: ${data.text?.length || 0} chars`);
    return res.status(200).json({ text: data.text });

  } catch (e) {
    console.error('STT error:', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
