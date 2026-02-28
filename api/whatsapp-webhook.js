import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- helpers ----------
function normalizeLine(line = '') {
  return line.replace(/\r/g, '').trim();
}

function extractCustomerName(text) {
  const firstLine = normalizeLine(text.split('\n')[0] || '');
  const m = firstLine.match(/^order\s*summary\s*-\s*(.+)$/i);
  return m?.[1]?.trim() || null;
}

function extractAfterDash(text, label) {
  const re = new RegExp(`^\\s*${label}\\s*-\\s*(.+)\\s*$`, 'i');
  const lines = text.split('\n').map(normalizeLine);
  for (const line of lines) {
    const m = line.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractTotalNumber(text) {
  const lines = text.split('\n').map(normalizeLine);
  for (const line of lines) {
    let m = line.match(/^total\s*-\s*(\d+(\.\d+)?)\s*$/i);
    if (m) return Number(m[1]);
    m = line.match(/^total\s*=\s*(\d+(\.\d+)?)\s*$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function extractItems(text) {
  const lines = text.split('\n').map(normalizeLine);

  const items = [];
  let insideItems = false;

  for (const line of lines) {
    if (/^items:/i.test(line)) {
      insideItems = true;
      continue;
    }
    if (!insideItems) continue;

    if (
      /^total\b/i.test(line) ||
      /^delivery\b/i.test(line) ||
      /^location\b/i.test(line) ||
      /^contact\b/i.test(line) ||
      /^payment\b/i.test(line)
    ) {
      break;
    }

    const match = line.match(/^(\d+)\s+(.+?)\s*-\s*(\d+(\.\d+)?)\s*$/);
    if (match) {
      items.push({
        name: match[2].trim(),
        qty: parseInt(match[1], 10),
        line_total: Number(match[3])
      });
    }
  }
  return items;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sumLineTotals(items) {
  return round2(items.reduce((acc, it) => acc + (Number(it.line_total) || 0), 0));
}

function parseMessage(text) {
  const customer_name = extractCustomerName(text);

  const delivery_date = extractAfterDash(text, 'Delivery Date');
  const delivery_time = extractAfterDash(text, 'Delivery Time');
  const address = extractAfterDash(text, 'Location');
  const phone = extractAfterDash(text, 'Contact');

  const items_json = extractItems(text);

  const stated_total = extractTotalNumber(text);
  const computed_total = sumLineTotals(items_json);

  let requires_review =
    customer_name && delivery_date && delivery_time && phone ? 'no' : 'yes';

  if (stated_total !== null) {
    const diff = Math.abs(round2(stated_total) - round2(computed_total));
    if (diff > 0.01) requires_review = 'yes';
  }

  return {
    customer_name,
    delivery_date,
    delivery_time,
    address,
    phone,
    items_json,
    stated_total: stated_total !== null ? round2(stated_total) : null,
    computed_total: round2(computed_total),
    requires_review
  };
}

export default async function handler(req, res) {
  // ===== WEBHOOK VERIFICATION =====
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  }

  // ===== RECEIVE MESSAGE =====
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // TEMP: log full payload so we can identify group id fields
      console.log('FULL WEBHOOK BODY:', JSON.stringify(body, null, 2));

      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      if (!message || message.type !== 'text') {
        return res.status(200).send('No text message');
      }

      const wa_message_id = message.id;
      const raw_message_text = message.text?.body || '';

      // TEMP SAFETY: ignore anything not starting with Order Summary -
      if (!raw_message_text.startsWith('Order Summary -')) {
        return res.status(200).send('Ignored');
      }

      const parsed = parseMessage(raw_message_text);

      const { error } = await supabase.from('orders').insert([
        {
          customer_name: parsed.customer_name || 'UNKNOWN',
          phone: parsed.phone ?? '',
          address: parsed.address ?? '',
          delivery_date: parsed.delivery_date,
          delivery_time: parsed.delivery_time ?? '',
          order_status: 'new',
          payment_status: 'unpaid',
          requires_review: parsed.requires_review,
          raw_message_text,
          wa_message_id,
          items_json: parsed.items_json,
          stated_total: parsed.stated_total,
          computed_total: parsed.computed_total
        }
      ]);

      if (error) {
        console.error('Supabase insert error:', error);
      }

      return res.status(200).send('Message received');
    } catch (err) {
      console.error('Server error:', err);
      return res.status(500).send('Server error');
    }
  }

  return res.status(405).send('Method not allowed');
}
