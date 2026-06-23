// One-off: verify the most recent order(s) and whether the shopper's card was
// charged or authorized. Cross-checks the DB order row against the live Stripe
// PaymentIntent (Stripe is the source of truth for money movement).
require('dotenv').config();
const { supabaseAdmin } = require('../src/config/supabase');
const { stripe } = require('../src/config/stripe');

(async () => {
  const { data: orders, error } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, status, payment_status, total_amount, stripe_payment_intent_id, shopper_id, created_at')
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) { console.error('DB error:', error.message); process.exit(1); }

  console.log(`\nMost recent ${orders.length} orders:\n`);
  for (const o of orders) {
    const when = new Date(o.created_at).toLocaleString();
    console.log(`• ${o.order_number || o.id.slice(0,8)} | status=${o.status} | payment_status=${o.payment_status} | total=$${o.total_amount} | ${when}`);
    if (!o.stripe_payment_intent_id) { console.log('    Stripe PI: (none created)\n'); continue; }
    try {
      const pi = await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id, { expand: ['latest_charge'] });
      const charged = (pi.amount_received || 0) > 0 || pi.status === 'succeeded';
      const authorized = pi.status === 'requires_capture';
      const verdict = charged ? '🔴 CHARGED' : authorized ? '🟠 AUTHORIZED (card hold, not charged)' : '🟢 NOT charged / not authorized';
      console.log(`    Stripe PI ${pi.id}`);
      console.log(`      status=${pi.status} | amount=$${(pi.amount/100).toFixed(2)} | amount_capturable=$${(pi.amount_capturable/100).toFixed(2)} | amount_received=$${(pi.amount_received/100).toFixed(2)}`);
      console.log(`      latest_charge=${pi.latest_charge ? (pi.latest_charge.id + ' captured=' + pi.latest_charge.captured + ' paid=' + pi.latest_charge.paid) : 'none'}`);
      console.log(`      → ${verdict}\n`);
    } catch (e) {
      console.log(`    Stripe PI ${o.stripe_payment_intent_id}: retrieve failed — ${e.message}\n`);
    }
  }

  // Stripe mode sanity
  console.log(`Stripe key mode: ${(process.env.STRIPE_SECRET_KEY||'').startsWith('sk_live') ? 'LIVE' : 'TEST'}`);
})();
