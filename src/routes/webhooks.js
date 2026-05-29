const router = require('express').Router();
const { stripe } = require('../config/stripe');
const stripeService = require('../services/stripeService');
const { supabaseAdmin } = require('../config/supabase');
const orderService = require('../services/orderService');

/**
 * Stripe requires the raw request body to verify webhook signatures.
 * This router is mounted BEFORE express.json() in app.js.
 */

router.post(
  '/stripe',
  // Parse raw body for signature verification
  require('express').raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('[WEBHOOK] Signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    console.log(`[WEBHOOK] Received event: ${event.type}`);

    try {
      switch (event.type) {

        // ── Payment authorized (manual-capture flow) ──────────────────────
        // With capture_method:'manual', the PI enters 'requires_capture' after
        // the shopper confirms their card. Stripe fires THIS event — not
        // payment_intent.succeeded — at that point. The actual capture (and
        // payment_intent.succeeded) happens later when the driver marks
        // the order as delivered and the server calls capturePaymentIntent().
        case 'payment_intent.amount_capturable_updated': {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          if (!orderId) break;

          // Only act when the PI just became capturable (i.e. card authorised)
          if (pi.status !== 'requires_capture') break;

          console.log(`[WEBHOOK] PI authorized — amount_capturable: $${(pi.amount_capturable / 100).toFixed(2)}, order: ${orderId}`);

          // Mark payment as authorized (pre-auth hold on card)
          // NOTE: payment_confirmed_at column added in migration v2 — included once that runs.
          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'authorized' })
            .eq('id', orderId);

          // Advance order from 'pending' → 'confirmed'
          const { data: pendingOrder } = await supabaseAdmin
            .from('orders')
            .select('status')
            .eq('id', orderId)
            .single();

          if (pendingOrder?.status === 'pending') {
            await orderService.updateOrderStatus({
              orderId,
              newStatus: 'confirmed',
              actorId:   'stripe-webhook',
            });
            console.log(`[WEBHOOK] Order ${orderId} advanced to confirmed`);
          }
          break;
        }

        // ── Payment fully captured (delivery completed) ───────────────────
        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          if (!orderId) break;

          // Mark order as fully paid
          // NOTE: payment_confirmed_at column added in migration v2.
          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'paid' })
            .eq('id', orderId);

          // Advance order to 'confirmed' if it somehow never got confirmed
          // (e.g. if amount_capturable_updated was missed)
          const { data: order } = await supabaseAdmin
            .from('orders')
            .select('status')
            .eq('id', orderId)
            .single();

          if (order?.status === 'pending') {
            await orderService.updateOrderStatus({
              orderId,
              newStatus: 'confirmed',
              actorId:   'stripe-webhook',
            });
          }
          break;
        }

        // ── Payment failed ────────────────────────────────────────────────
        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          if (!orderId) break;

          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'failed' })
            .eq('id', orderId);

          await orderService.updateOrderStatus({
            orderId,
            newStatus: 'cancelled',
            actorId:   'stripe-webhook',
          }).catch(() => {}); // order may already be cancelled
          break;
        }

        // ── Refund processed ──────────────────────────────────────────────
        case 'charge.refunded': {
          const charge = event.data.object;
          const pi = charge.payment_intent;

          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'refunded', refunded_at: new Date().toISOString() })
            .eq('stripe_payment_intent_id', pi);
          break;
        }

        // ── Boutique Connect account updated ──────────────────────────────
        case 'account.updated': {
          const account = event.data.object;
          const boutiqueId = account.metadata?.boutique_id;
          const driverId   = account.metadata?.driver_id;

          const isReady = account.charges_enabled && account.payouts_enabled;

          if (boutiqueId) {
            await supabaseAdmin
              .from('boutiques')
              .update({ stripe_onboarding_complete: isReady })
              .eq('stripe_account_id', account.id);
          }
          if (driverId) {
            await supabaseAdmin
              .from('drivers')
              .update({ stripe_onboarding_complete: isReady })
              .eq('stripe_account_id', account.id);
          }
          break;
        }

        // ── Transfer paid to boutique ─────────────────────────────────────
        // NOTE: transferToBoutique() is already called inside updateOrderStatus()
        // when the order reaches 'delivered' or 'completed'. We do NOT call it
        // again here — doing so would double-transfer funds to the boutique.
        // This handler exists only for logging / audit purposes.
        case 'transfer.created': {
          const transfer = event.data.object;
          console.log(`[WEBHOOK] Transfer created: ${transfer.id} → destination ${transfer.destination}, amount $${(transfer.amount / 100).toFixed(2)}`);
          break;
        }

        // ── Payment intent cancelled ───────────────────────────────────────
        case 'payment_intent.canceled': {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          if (!orderId) break;
          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'cancelled' })
            .eq('id', orderId)
            .catch(() => {});
          break;
        }

        // ── Payout paid to recipient bank account ─────────────────────────
        case 'payout.paid': {
          const payout = event.data.object;
          const payoutId = payout.metadata?.payout_id;
          if (payoutId) {
            await supabaseAdmin
              .from('payouts')
              .update({ status: 'paid', stripe_transfer_id: payout.id })
              .eq('id', payoutId)
              .catch(() => {});

            // Notify recipient
            const { data: payoutRecord } = await supabaseAdmin
              .from('payouts')
              .select('recipient_id, recipient_type, amount')
              .eq('id', payoutId)
              .single()
              .catch(() => ({ data: null }));

            if (payoutRecord) {
              await supabaseAdmin
                .from('notifications')
                .insert({
                  user_id: payoutRecord.recipient_id,
                  type: 'payout_sent',
                  title: '💸 Payout Sent',
                  body: `Your payout of $${parseFloat(payoutRecord.amount).toFixed(2)} has been sent to your bank account.`,
                  data: { payout_id: payoutId },
                  is_read: false,
                  sent_push: false,
                })
                .catch(() => {});
            }
          }
          break;
        }

        // ── Payout failed ─────────────────────────────────────────────────
        case 'payout.failed': {
          const payout = event.data.object;
          const payoutId = payout.metadata?.payout_id;
          if (payoutId) {
            await supabaseAdmin
              .from('payouts')
              .update({ status: 'failed' })
              .eq('id', payoutId)
              .catch(() => {});
          }
          console.error('[WEBHOOK] ⚠️ Payout FAILED:', payout.id, 'Payout record:', payoutId);
          break;
        }

        // ── Transfer reversed (refund/reversal) ───────────────────────────
        case 'transfer.reversed': {
          const transfer = event.data.object;
          console.log('[WEBHOOK] Transfer reversed:', transfer.id, 'Amount reversed:', transfer.amount_reversed);
          // Log for manual review — reversals are rare and handled case-by-case
          break;
        }

        default:
          console.log(`[WEBHOOK] Unhandled event type: ${event.type}`);
      }
    } catch (err) {
      console.error(`[WEBHOOK] Handler error for ${event.type}:`, err.message);
      // Return 200 so Stripe doesn't retry — log for manual review
    }

    res.json({ received: true });
  }
);

module.exports = router;
