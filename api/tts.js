// POST /api/tts { text } -> audio/wav (Gemini TTS, female voice "Kore")
// Converts the raw PCM (L16, 24kHz, mono) to a WAV the browser can play.

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
  const text = (body && typeof body.text === 'string' ? body.text : '').slice(0, 800);
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=' + key;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say warmly and naturally, like a friendly Indian clinic care coordinator on a phone call: ' + text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      })
    });
    const j = await r.json().catch(function () { return null; });
    const part = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0];
    const b64 = part && part.inlineData && part.inlineData.data;
    if (!b64) {
      const msg = j && j.error && j.error.message ? j.error.message : 'no audio';
      return res.status(502).json({ error: msg.slice(0, 150) });
    }
    const pcm = Buffer.from(b64, 'base64');

    // Wrap PCM L16 24kHz mono in a WAV header.
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);      // PCM
    header.writeUInt16LE(1, 22);      // mono
    header.writeUInt32LE(24000, 24);  // sample rate
    header.writeUInt32LE(24000 * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);      // block align
    header.writeUInt16LE(16, 34);     // bits per sample
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.concat([header, pcm]));
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message || e).slice(0, 150) });
  }
};
