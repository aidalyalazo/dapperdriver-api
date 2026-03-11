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

        // ── Payment succeeded ─────────────────────────────────────────────
        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          const orderId = pi.metadata?.order_id;
          if (!orderId) break;

          // Mark order as payment confirmed
          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'paid', payment_confirmed_at: new Date().toISOString() })
            .eq('id', orderId);

          // Advance order to 'confirmed' if still pending
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
        case 'transfer.created': {
          const transfer = event.data.object;
          const orderId = transfer.metadata?.order_id;

          if (orderId) {
            // Auto-transfer to boutique when order is delivered
            // (If not already done by transferToBoutique in orderService)
            const { data: order } = await supabaseAdmin
              .from('orders')
              .select('status, boutique_id')
              .eq('id', orderId)
              .single();

            if (order?.status === 'delivered') {
              await stripeService.transferToBoutique(order).catch((e) =>
                console.warn('[WEBHOOK] transferToBoutique already done or failed:', e.message)
              );
            }
          }
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

        // ── Transfer paid to recipient ─────────────────────────────────────
        case 'transfer.paid': {
          const transfer = event.data.object;
          const payoutId = transfer.metadata?.payout_id;
          if (payoutId) {
            await supabaseAdmin
              .from('payouts')
              .update({ status: 'paid', stripe_transfer_id: transfer.id })
              .eq('id', payoutId)
              .catch(() => {});

            // Notify recipient
            const { data: payout } = await supabaseAdmin
              .from('payouts')
              .select('recipient_id, recipient_type, amount')
              .eq('id', payoutId)
              .single()
              .catch(() => ({ data: null }));

            if (payout) {
              await supabaseAdmin
                .from('notifications')
                .insert({
                  user_id: payout.recipient_id,
                  type: 'payout_sent',
                  title: '💸 Payout Sent',
                  body: `Your payout of $${parseFloat(payout.amount).toFixed(2)} has been sent to your bank account.`,
                  data: { payout_id: payoutId },
                  is_read: false,
                  sent_push: false,
                })
                .catch(() => {});
            }
          }
          break;
        }

        // ── Transfer failed ───────────────────────────────────────────────
        case 'transfer.failed': {
          const transfer = event.data.object;
          const payoutId = transfer.metadata?.payout_id;
          if (payoutId) {
            await supabaseAdmin
              .from('payouts')
              .update({ status: 'failed' })
              .eq('id', payoutId)
              .catch(() => {});
          }
          // Alert admin
          console.error('[WEBHOOK] ⚠️ Transfer FAILED:', transfer.id, 'Payout:', payoutId);
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
