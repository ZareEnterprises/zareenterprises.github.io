// Summarizes a student's Interview Prep answers using Google Gemini (free tier).
// Two modes:
//   - "prelim": summarizes one preliminary Spanish answer into a short conclusion.
//   - "final":  drafts a suggested English answer to a real audition question,
//               built from that question's preliminary Q&A pairs.
// The Gemini API key never reaches the browser — it's read from Deno.env
// here, set via `supabase secrets set GEMINI_API_KEY=... --project-ref gpoddvcrsdkpgfmyniqu`.
// Get a free key at https://aistudio.google.com/apikey.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EMN_SUPABASE_URL = 'https://gpoddvcrsdkpgfmyniqu.supabase.co';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error: ${errText}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const callerClient = createClient(EMN_SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await callerClient.auth.getUser();
    if (authError || !user) return json({ error: 'Not authenticated' }, 401);

    const body = await req.json();

    if (body.mode === 'prelim') {
      const { question, answer } = body;
      if (!question || !answer) return json({ error: 'Missing question or answer' }, 400);

      const prompt = `Sos un coach de admisiones de Berklee. Un alumno respondió esta pregunta previa en español, como parte de su preparación para la entrevista de audición.

Pregunta: "${question}"
Respuesta del alumno: "${answer}"

Escribí una conclusión breve (2-3 frases, en español) que resuma la idea central de su respuesta y resalte qué es lo más valioso o distintivo de lo que contó. Sé cálido y directo, sin relleno.`;

      const summary = await callGemini(prompt);
      return json({ summary });
    }

    if (body.mode === 'final') {
      const { finalQuestion, prelimQAs } = body;
      if (!finalQuestion || !Array.isArray(prelimQAs)) return json({ error: 'Missing finalQuestion or prelimQAs' }, 400);

      const qaText = prelimQAs
        .map((qa: { question: string; answer: string }) => `- ${qa.question}\n  ${qa.answer || '(sin responder)'}`)
        .join('\n');

      const prompt = `Sos un coach de admisiones de Berklee ayudando a un alumno a preparar su entrevista de audición.

Pregunta real de la entrevista (en inglés): "${finalQuestion}"

El alumno respondió estas preguntas previas en español para pensar su respuesta:
${qaText}

Con base en esas respuestas, armá un borrador de respuesta en INGLÉS a la pregunta real, en primera persona, natural y auténtico (no genérico) — que suene a él/ella y no a una respuesta de manual. El alumno lo va a poder editar después. Dividilo en dos partes:
- INTRO: una sola frase corta y contundente que resuma la idea central (esto va a mostrarse en negrita como apertura).
- EXPLICACION: 3-5 frases que desarrollen la idea con más detalle y ejemplos concretos.

Respondé EXACTAMENTE en este formato, sin nada más antes o después:
INTRO: <la frase>
EXPLICACION: <el desarrollo>`;

      const raw = await callGemini(prompt);
      const introMatch = raw.match(/INTRO:\s*([\s\S]*?)(?=\nEXPLICACION:|$)/i);
      const explicacionMatch = raw.match(/EXPLICACION:\s*([\s\S]*)/i);
      const introDraft = introMatch ? introMatch[1].trim() : raw.trim();
      const explicacionDraft = explicacionMatch ? explicacionMatch[1].trim() : '';
      return json({ introDraft, explicacionDraft });
    }

    return json({ error: 'Unknown mode' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
