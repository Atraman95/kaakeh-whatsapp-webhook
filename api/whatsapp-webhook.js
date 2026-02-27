import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- parsing helpers ----------
function normalizeLine(line = '') {
  return line.replace(/\r/g, '').trim();
}

function extractAfterDash(text, label) {
  // Matches: "Label - value" (case-insensitive), returns value
  // Example: extractAfterDash(msg, "Delivery Date") -> "2026-02-28"
  const re = new RegExp(`^\\s*${label}\\s*-\\s*(.+)\\s*$`, 'i');
  const lines = text.split('\n').map(normalizeLine);
  for (const line of lines) {
    const m = line.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractCustomerName(text) {
  const firstLine = normalizeLine(text.split('\n')[0] || '');
  // Expected: "Order Summary - Name"
  const m = firstLine.match(/^order\s*summary\s*-\s*(.+)$/i);
  return m?.[1]?.trim() || null;
}

function parseMessage(text) {
  const customer_name = extractCustomerName(text);

  // Preferred (new) template labels:
  const delivery_date =
    extractAfterDash(text, 'Delivery Date') ||
    null;

  const delivery_time =
    extractAfterDash(text, 'Delivery Time') ||
    null;

  const address =
    extractAfterDash(text, 'Location') ||
    null;

  const phone =
    extractAfterDash(text, 'Contact') ||
    null;

  // Minimal “needs review” logic:
  // Require customer + delivery date/time + phone (address can be TBD sometimes)
  const requires_review =
    customer_name && delivery_date && delivery_time && phone ? 'no' : 'yes';

  return {
    customer_name,
    delivery_date,
    delivery_time,
    address,
    phone,
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
      const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      // Ignore webhook noise / non-text
      if (!message || message.type !== 'text') {
        return res.status(200).send('No text message');
      }

      const wa_message_id = message.id;
      const raw_message_text = message.text?.body || '';

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
          wa_message_id
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
