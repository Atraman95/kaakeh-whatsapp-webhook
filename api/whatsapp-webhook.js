import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

      if (!message || message.type !== 'text') {
        return res.status(200).send('No text message');
      }

      const text = message.text.body || '';
      const waMessageId = message.id;

      const firstLine = text.split('\n')[0] || '';
      const customerName = firstLine.replace('Order Summary -', '').trim() || null;

      // Simple validation checks
      const hasDeliveryDate = text.includes('Delivery Date -');
      const hasDeliveryTime = text.includes('Delivery Time -');
      const hasContact = text.includes('Contact -');

      const requiresReview =
        hasDeliveryDate && hasDeliveryTime && hasContact ? 'no' : 'yes';

      const { error } = await supabase.from('orders').insert([
        {
          customer_name: customerName,
          raw_message_text: text,
          wa_message_id: waMessageId,
          order_status: 'new',
          payment_status: 'unpaid',
          requires_review: requiresReview
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
