// api/chat.js — Vercel serverless function for Spanish tutor chat
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages array' });
    }

    // Spanish-only tutor system prompt
    const systemPrompt = {
      role: "system",
      content:
        "Eres un tutor de español amable para principiantes (A1–A2) con enfoque latinoamericano. " +
        "Usa un tono cálido y motivador. RESPONDE MÁXIMO 2 MENSAJES EN ESPAÑOL:\n\n" +
        "OPCIÓN 1 - Solo corrección (si hay errores significativos o inglés):\n" +
        "- correction_es: Si el usuario habla en inglés, proporciona el equivalente en español (sin regañar, solo ayuda). " +
        "Si hay errores de español, corrección breve y amable.\n" +
        "- reply_es: respuesta principal con pregunta de seguimiento\n" +
        "- needs_correction: true\n\n" +
        "OPCIÓN 2 - Solo respuesta principal (si el español está perfecto):\n" +
        "- correction_es: null\n" +
        "- reply_es: validación + respuesta + pregunta\n" +
        "- needs_correction: false\n\n" +
        "Reglas importantes:\n" +
        "- SIEMPRE responde en español (reply_es y correction_es)\n" +
        "- Si usuario usa inglés, convierte a español en correction_es (ejemplo: 'hello' → 'Intenta decir: hola')\n" +
        "- No corrijas nombres propios\n" +
        "- Sé amable y motivador\n" +
        "- Devuelve JSON con: ok, reply_es, needs_correction, correction_es"
    };

    const allMessages = [systemPrompt, ...messages];

    // Call OpenAI
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o',
        messages: allMessages,
        max_tokens: 600,
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });

    if (!r.ok) {
      const errorText = await r.text();
      console.error('OpenAI API error:', r.status, errorText);
      return res.status(r.status).json({ error: errorText });
    }

    const data = await r.json();
    const rawContent = data.choices?.[0]?.message?.content || '{}';

    let parsed;
    let parseSuccess = true;
    try {
      parsed = JSON.parse(rawContent);
    } catch (e) {
      console.error('JSON parse error:', e);
      parsed = {};
      parseSuccess = false;
    }

    // Server-side normalization: ensure all required fields present
    const normalized = {
      ok: parseSuccess,
      reply_es: parsed.reply_es || parsed.response || "¡Muy bien! ¿Puedes repetir eso?",
      needs_correction: !!parsed.needs_correction,
      correction_es: parsed.correction_es || null
    };

    // Log metadata only (not full content) in production
    if (process.env.NODE_ENV !== 'production') {
      console.log('Chat response:', normalized);
    } else {
      console.log('Chat response:', { 
        ok: normalized.ok, 
        needs_correction: normalized.needs_correction,
        has_correction: !!normalized.correction_es,
        has_translation: !!normalized.translation_
    }

    return res.status(200).json(normalized);

  } catch (e) {
    console.error('Chat error:', e);
    return res.status(500).json({ 
      error: e.message || 'Internal server error',
      ok: false
    });
  }
}
