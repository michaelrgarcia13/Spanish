// api/translate.js — Vercel serverless function for translation
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        max_tokens: 200,
        temperature: 0.3
      })
    });

    if (!r.ok) {
      const errorText = await r.text();
      console.error('OpenAI translation error:', r.status, errorText);
      return res.status(r.status).send(errorText);
    }

    const data = await r.json();
    const translation = data.choices?.[0]?.message?.content?.trim() || '';

    return res.status(200).json({ translation });

  } catch (e) {
    console.error('Translation error:', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
