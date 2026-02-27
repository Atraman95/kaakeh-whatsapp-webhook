import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // ===== WEBHOOK VERIFICATION (Meta sends GET request first) =====
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send('Verification failed');
    }
  }

  // ===== RECEIVE MESSAGE =====
  if (req.method === 'POST') {
    try {
      const body = req.body;

      const message =
        body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      if (!message || message.type !== 'text') {
        return res.status(200).send('No text message');
      }

      const text = message.text.body;
      const waMessageId = message.id;

      // Simple parser: extract customer name from first line
      const firstLine = text.split('\n')[0];
      const customerName = firstLine.replace('Order Summary -', '').trim();

      // Insert into Supabase (minimal for now)
      const { error } = await supabase.from('orders').insert([
        {
          customer_name: customerName,
          raw_message_text: text,
          wa_message_id: waMessageId
        }
      ]);

      if (error) {
        console.error(error);
      }

      return res.status(200).send('Message received');
    } catch (err) {
      console.error(err);
      return res.status(500).send('Server error');
    }
  }

  return res.status(405).send('Method not allowed');
}
