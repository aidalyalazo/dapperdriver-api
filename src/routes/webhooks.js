const router = require('express').Router();
const { stripe } = require('../config/stripe');
const stripeService = require('../services/stripeService');
const { supabaseAdmin } = require('../config/supabase');
const orderService = require('../services/orderService');
const { notifyAdmins } = require('../utils/adminAlerts');

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
      // ── Try-on PI guard ────────────────────────────────────────────────────
      // Try-on PaymentIntents carry metadata.type starting with 'try_on_'.
      // Acknowledge and return early — do NOT fall through to the order branch.
      // The full try-on handler is added in Phase 1.
      const piMeta = event.data?.object?.metadata || {};
      if (piMeta.type && piMeta.type.startsWith('try_on_')) {
        await handleTryOnWebhook(event, piMeta);
        return res.json({ received: true });
      }

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

          // Decision A (additive): on full capture convert holds → call decrementStock
          // This is idempotent — convertHolds is a no-op if holds are already converted.
          try {
            const { convertHolds } = require('../services/tryOnInventoryService');
            const { data: heldItems } = await supabaseAdmin
              .from('inventory_holds')
              .select('product_id')
              .eq('order_id', orderId)
              .eq('status', 'active');
            if (heldItems && heldItems.length > 0) {
              const keptIds = heldItems.map((h) => h.product_id);
              await convertHolds(orderId, 'order', keptIds);
              console.log(`[WEBHOOK] Decision A: converted ${keptIds.length} holds for order ${orderId}`);
            }
          } catch (holdErr) {
            // Non-fatal: hold conversion failure should not prevent order state advance
            console.error('[WEBHOOK] Hold conversion error on capture:', holdErr.message);
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
          // Decision A (additive): release holds on payment failure
          try {
            const failedPi = event.data.object;
            const failedOrderId = failedPi.metadata?.order_id;
            if (failedOrderId) {
              const { releaseHoldsForOrder } = require('../services/tryOnInventoryService');
              await releaseHoldsForOrder(failedOrderId);
            }
          } catch (holdErr) {
            console.error('[WEBHOOK] Hold release error on payment_failed:', holdErr.message);
          }
          break;
        }

        // ── Refund processed ──────────────────────────────────────────────
        case 'charge.refunded': {
          const charge = event.data.object;
          const pi = charge.payment_intent;

          // Idempotent: duplicate webhook deliveries must not re-stamp refunded_at
          await supabaseAdmin
            .from('orders')
            .update({ payment_status: 'refunded', refunded_at: new Date().toISOString() })
            .eq('stripe_payment_intent_id', pi)
            .neq('payment_status', 'refunded');
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
          await Promise.resolve(supabaseAdmin
            .from('orders')
            .update({ payment_status: 'cancelled' })
            .eq('id', orderId))
            .catch(() => {});
          // Cancel the order itself if it's still open — this also restores the
          // inventory that was decremented at order creation (fn_restore_order_stock
          // inside updateOrderStatus). Previously this path only released holds
          // (which are disabled by default), so abandoned-checkout stock leaked.
          // updateOrderStatus throws on an already-terminal order → no double-restore.
          try {
            const { data: ord } = await supabaseAdmin
              .from('orders').select('status').eq('id', orderId).single();
            if (ord && !['cancelled', 'delivered', 'completed'].includes(ord.status)) {
              await orderService.updateOrderStatus({ orderId, newStatus: 'cancelled', actorId: 'stripe-webhook' });
            }
          } catch (e) {
            console.warn('[WEBHOOK] cancel-restore failed:', orderId, e.message);
          }
          // Legacy holds release (no-op unless inventory holds are enabled).
          try {
            const { releaseHoldsForOrder } = require('../services/tryOnInventoryService');
            await releaseHoldsForOrder(orderId);
          } catch (holdErr) {
            console.error('[WEBHOOK] Hold release error on cancel:', holdErr.message);
          }
          break;
        }

        // ── Payout paid to recipient bank account ─────────────────────────
        case 'payout.paid': {
          const payout = event.data.object;
          const payoutId = payout.metadata?.payout_id;
          if (payoutId) {
            // Idempotent: only the first delivery advances + notifies
            const { data: advanced } = await Promise.resolve(supabaseAdmin
              .from('payouts')
              .update({ status: 'paid', stripe_transfer_id: payout.id })
              .eq('id', payoutId)
              .neq('status', 'paid')
              .select('recipient_id, recipient_type, amount')
              .single())
              .catch(() => ({ data: null }));

            const payoutRecord = advanced;
            if (payoutRecord) {
              await Promise.resolve(supabaseAdmin
                .from('notifications')
                .insert({
                  user_id: payoutRecord.recipient_id,
                  type: 'payout_sent',
                  title: '💸 Payout Sent',
                  body: `Your payout of $${parseFloat(payoutRecord.amount).toFixed(2)} has been sent to your bank account.`,
                  data: { payout_id: payoutId },
                  is_read: false,
                  sent_push: false,
                }))
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
            await Promise.resolve(supabaseAdmin
              .from('payouts')
              .update({ status: 'failed' })
              .eq('id', payoutId))
              .catch(() => {});
          }
          console.error('[WEBHOOK] ⚠️ Payout FAILED:', payout.id, 'Payout record:', payoutId);
          break;
        }

        // ── Chargeback / dispute filed on an ORDER charge ──────────────────
        // The biggest silent money-loss hole: the cardholder's bank claws back
        // funds, but the boutique/driver may already have been paid. We can't
        // safely auto-reverse payouts here (transfer→order mapping isn't 1:1 for
        // weekly driver batches), so surface it to ops IMMEDIATELY so they can
        // respond in Stripe before the deadline.
        case 'charge.dispute.created': {
          const dispute = event.data.object;
          const piId = dispute.payment_intent;
          if (!piId) break;
          const { data: order } = await supabaseAdmin
            .from('orders')
            .select('id, total_amount, boutique_paid, driver_paid, boutique_id')
            .eq('stripe_payment_intent_id', piId)
            .maybeSingle();
          if (!order) break; // not an order PI
          await notifyAdmins({
            type: 'chargeback',
            title: '⚠️ Chargeback filed',
            body: `Dispute on order ${order.id} for $${Number(order.total_amount).toFixed(2)}. ` +
                  `Boutique paid: ${order.boutique_paid}, driver paid: ${order.driver_paid}. ` +
                  `Submit evidence in the Stripe dashboard before the response deadline.`,
            data: { order_id: order.id, dispute_id: dispute.id, amount: dispute.amount, reason: dispute.reason },
          });
          await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
            order_id: order.id, status: 'disputed', timestamp: new Date().toISOString(),
          })).catch(() => {});
          console.warn(`[WEBHOOK] Chargeback on order ${order.id} — dispute ${dispute.id}`);
          break;
        }

        // ── Transfer reversed (boutique/driver payout clawed back) ─────────
        case 'transfer.reversed': {
          const transfer = event.data.object;
          console.warn('[WEBHOOK] Transfer reversed:', transfer.id, 'amount:', transfer.amount_reversed);
          await notifyAdmins({
            type: 'transfer_reversed',
            title: '⚠️ Payout transfer reversed',
            body: `Stripe transfer ${transfer.id} was reversed ($${(transfer.amount_reversed / 100).toFixed(2)}). ` +
                  `Review the linked payout/order — the recipient may still show as paid.`,
            data: { transfer_id: transfer.id, amount_reversed: transfer.amount_reversed, destination: transfer.destination },
          });
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

// ── Try-on webhook handler (separate branch — never touches order branch) ──────

async function handleTryOnWebhook(event, meta) {
  const sessionId = meta.session_id;
  if (!sessionId) return;

  try {
    switch (event.type) {

      // Fee PI authorized → advance booked → pickup_pending
      case 'payment_intent.amount_capturable_updated': {
        if (meta.type !== 'try_on_session_fee') break;
        const pi = event.data.object;
        if (pi.status !== 'requires_capture') break;

        await supabaseAdmin
          .from('try_on_sessions')
          .update({ status: 'pickup_pending', updated_at: new Date().toISOString() })
          .eq('id', sessionId)
          .eq('status', 'booked');  // idempotent — only advances from booked

        console.log(`[WEBHOOK/TryOn] Fee authorized — session ${sessionId} → pickup_pending`);
        break;
      }

      // Fee PI captured (on session completion)
      case 'payment_intent.succeeded': {
        if (!['try_on_session_fee', 'try_on_session_items'].includes(meta.type)) break;
        await supabaseAdmin
          .from('try_on_sessions')
          .update({ updated_at: new Date().toISOString() })
          .eq('id', sessionId);
        console.log(`[WEBHOOK/TryOn] PI succeeded — session ${sessionId} type=${meta.type}`);
        break;
      }

      // Any try-on PI cancelled → release holds + mark session cancelled
      case 'payment_intent.canceled': {
        const { releaseHoldsForSession } = require('../services/tryOnInventoryService');
        await releaseHoldsForSession(sessionId);

        await supabaseAdmin
          .from('try_on_sessions')
          .update({
            status:       'cancelled',
            cancelled_at: new Date().toISOString(),
            cancelled_by: 'stripe-webhook',
            updated_at:   new Date().toISOString(),
          })
          .eq('id', sessionId)
          .not('status', 'in', '("completed","cancelled")');

        console.log(`[WEBHOOK/TryOn] PI canceled — session ${sessionId} holds released`);
        break;
      }

      // Dispute filed — flag the shopper silently for admin review
      case 'charge.dispute.created': {
        await Promise.resolve(supabaseAdmin
          .from('try_on_shopper_flags')
          .insert({
            shopper_id:  meta.shopper_id,
            session_id:  sessionId,
            flag_type:   'dispute',
            severity:    'critical',
            notes:       `Stripe dispute on ${meta.type} PI — session ${sessionId}`,
          }))
          .catch(() => {});
        console.warn(`[WEBHOOK/TryOn] Dispute filed for session ${sessionId}`);
        break;
      }

      default:
        console.log(`[WEBHOOK/TryOn] Unhandled event: ${event.type} session=${sessionId}`);
    }
  } catch (err) {
    console.error(`[WEBHOOK/TryOn] Handler error for ${event.type}:`, err.message);
    // Return 200 to Stripe so it doesn't retry — log for manual review
  }
}

module.exports = router;
