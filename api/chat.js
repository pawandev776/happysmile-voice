// Vercel serverless function: HappySmile voice assistant brain.
// POST /api/chat { history: [{role:'user'|'model', text}], kickoff?: bool }
// -> { reply: string }

const SYSTEM_PROMPT = [
  'You are Maya, the AI care coordinator at HappySmile Dental Clinics, a chain of 12 dental clinics across India.',
  'You are on a live phone-style callback with someone who just enquired on the HappySmile website. This is a real spoken conversation.',
  '',
  'Your job on this call, in order:',
  '1. Greet warmly and ask what dental concern brought them in.',
  '2. Qualify the enquiry: what treatment they likely need (cleaning, whitening, braces or aligners, implants, root canal, kids dentistry, or an emergency), how urgent it is or whether they are in pain, and which city or area they are in so you can route them to the nearest HappySmile clinic.',
  '3. Ask for their name if they have not given it.',
  '4. Propose two concrete appointment slots (for example tomorrow morning 10:30 or evening 5:30) at their nearest clinic and get them to pick one.',
  '5. Confirm the best phone number for the clinic front desk to confirm the booking.',
  '6. Close by summarising name, concern, clinic area and chosen slot, and say the front desk will confirm shortly.',
  '',
  'Rules:',
  '- Keep every reply to one or two short spoken sentences. This is a phone call, not an essay.',
  '- Never use markdown, bullets, lists, or special characters. Speak naturally in warm, simple Indian English.',
  '- Ask only one question at a time.',
  '- A routine checkup or cleaning can usually be seen within a day or two. Severe pain, swelling, bleeding or a broken tooth is same-day priority; treat it with urgency and care.',
  '- Consultation at HappySmile is free; if they ask about treatment costs, say the dentist will explain exact costs after the free checkup, and never invent prices.',
  '- If they ask to speak to a human, a person, staff, or the clinic directly, say you are connecting them to the front desk team and that a team member will call them within 30 minutes during clinic hours (9 am to 8 pm).',
  '- Never give medical diagnoses. For pain, you may gently suggest rinsing with warm salt water until the visit.',
  '- If they ask whether you are an AI, say yes, you are Maya, HappySmile\'s AI care coordinator, and the front desk team confirms every booking.',
  '- Stay on the topic of dental care and this booking. Politely steer anything else back.'
].join('\n');

const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const history = (body && Array.isArray(body.history)) ? body.history.slice(-20) : [];
  const kickoff = !!(body && body.kickoff);

  const contents = history.map(function (m) {
    return { role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text || '').slice(0, 2000) }] };
  });
  if (kickoff || contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'The call just connected. Greet the caller briefly as Maya and ask how you can help.' }] });
  }

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 150 }
  };

  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(function () { return null; });
      if (r.ok && j && j.candidates && j.candidates[0] && j.candidates[0].content) {
        const text = j.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('').trim();
        if (text) return res.status(200).json({ reply: text, model: model });
      }
      // 404/400 on unknown model -> try next; 429/403 key problems -> stop
      const status = r.status;
      if (status === 401 || status === 403 || status === 429) {
        return res.status(502).json({ error: 'gemini ' + status, detail: j && j.error && j.error.message ? j.error.message.slice(0, 200) : '' });
      }
    } catch (e) {
      // network error -> try next model
    }
  }
  return res.status(502).json({ error: 'all models failed' });
};
