// POST /api/book { history, email }
// Extracts the confirmed booking from the call, emails a real .ics invite, and
// returns a Google Calendar link as a second channel.

const EXTRACT_PROMPT = [
  'You read a transcript of a phone call between Maya (HappySmile Dental AI coordinator) and a caller.',
  'Today is {TODAY} and the current time is {NOWIST} in Asia/Kolkata.',
  'Extract the confirmed booking as strict JSON with exactly these keys:',
  '{"name": string|null, "concern": string|null, "clinic_area": string|null, "date": "YYYY-MM-DD"|null, "time": "HH:MM 24h"|null, "phone": string|null}',
  'Resolve relative slot words like today or tomorrow against the date above. Use null for anything the caller did not actually say.',
  'Output ONLY the JSON object, no other text.'
].join('\n');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.GEMINI_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const history = (body && Array.isArray(body.history)) ? body.history : [];
  const email = (body && typeof body.email === 'string') ? body.email.trim() : '';
  if (!history.length) return res.status(400).json({ error: 'history required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });

  // 1. Extract structured booking from the transcript.
  const now = new Date();
  const istFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', dateStyle: 'short' });
  const today = istFmt.format(now); // YYYY-MM-DD in en-CA
  const nowIst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(now);
  const transcript = history.map(function (m) { return (m.role === 'model' ? 'Maya' : 'Caller') + ': ' + m.text; }).join('\n').slice(0, 6000);
  const prompt = EXTRACT_PROMPT.replace('{TODAY}', today).replace('{NOWIST}', nowIst) + '\n\nTRANSCRIPT:\n' + transcript;

  let details = null;
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=' + key;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 300 } })
    });
    const j = await r.json();
    const text = j.candidates && j.candidates[0] && j.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('').trim();
    const match = text && text.match(/\{[\s\S]*\}/);
    if (match) details = JSON.parse(match[0]);
  } catch (e) { /* fall through */ }
  if (!details || !details.date || !details.time) {
    return res.status(422).json({ error: 'could not confirm booking details from the call yet' });
  }

  const area = details.clinic_area || 'your nearest';
  const concern = details.concern || 'dental visit';
  const name = details.name || 'there';

  // 2. Build the .ics invite (30 minute visit, Asia/Kolkata).
  const dt = details.date.replace(/-/g, '') + 'T' + details.time.replace(':', '') + '00';
  const pad = function (n) { return String(n).padStart(2, '0'); };
  const tparts = details.time.split(':');
  let eh = parseInt(tparts[0], 10), em = parseInt(tparts[1], 10) + 30;
  if (em >= 60) { eh += 1; em -= 60; }
  const dtEnd = details.date.replace(/-/g, '') + 'T' + pad(eh) + pad(em) + '00';
  const summary = 'HappySmile Dental - ' + concern;
  const location = 'HappySmile Dental Clinic, ' + area;
  const description = 'Booking for ' + name + (details.phone ? ' (phone ' + details.phone + ')' : '') + '. The HappySmile front desk will call to confirm.';
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HappySmile Dental//Callback Demo//EN',
    'BEGIN:VEVENT',
    'UID:' + Date.now() + '@happysmile-voice.vercel.app',
    'DTSTAMP:' + dt,
    'DTSTART;TZID=Asia/Kolkata:' + dt,
    'DTEND;TZID=Asia/Kolkata:' + dtEnd,
    'SUMMARY:' + summary,
    'LOCATION:' + location,
    'DESCRIPTION:' + description,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');

  // 3. Google Calendar template link as the second channel.
  const gcal = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(summary)
    + '&dates=' + dt + '/' + dtEnd + '&ctz=Asia/Kolkata'
    + '&location=' + encodeURIComponent(location)
    + '&details=' + encodeURIComponent(description);

  // 4. Email the invite via the free transactional tier.
  let sent = false;
  let sendError = null;
  if (resendKey) {
    try {
      const er = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'HappySmile Dental <onboarding@resend.dev>',
          to: [email],
          subject: 'Your HappySmile appointment - ' + details.date + ' ' + details.time,
          html: '<p>Hi ' + name + ',</p>'
            + '<p>Your HappySmile Dental visit for <b>' + concern + '</b> is booked at our <b>' + area + '</b> clinic on <b>' + details.date + '</b> at <b>' + details.time + '</b> (IST).</p>'
            + '<p>The calendar invite is attached, or add it in one tap: <a href="' + gcal + '">Add to Google Calendar</a>.</p>'
            + '<p>Our front desk will call you to confirm. See you soon!</p>',
          attachments: [{ filename: 'happysmile-visit.ics', content: Buffer.from(ics).toString('base64') }]
        })
      });
      const ej = await er.json().catch(function () { return null; });
      sent = er.ok;
      if (!er.ok) sendError = (ej && ej.message) || ('resend ' + er.status);
    } catch (e) { sendError = String(e && e.message || e).slice(0, 120); }
  } else {
    sendError = 'RESEND_API_KEY not set';
  }

  return res.status(200).json({
    sent: sent,
    sendError: sendError,
    calendarUrl: gcal,
    when: details.date + ' ' + details.time,
    clinic: area,
    concern: concern,
    name: name
  });
};
