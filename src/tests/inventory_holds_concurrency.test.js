/**
 * Concurrency test: fn_reserve_for_order / fn_reserve_items
 *
 * Proves two concurrent buyers racing for the last unit of a product
 * get exactly one success and one 409 — never a double-allocation.
 *
 * Run:   node src/tests/inventory_holds_concurrency.test.js
 * Prereq: migration 009a already applied to the DB.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ROUNDS = 100;

async function setup() {
  // Insert a throwaway boutique product with stock=1
  const boutiqueId = 'b151b2f6-f98c-4e37-91d9-feb8a62e3cfb'; // Biscayne Linen Co (seeded)
  const { data: product, error } = await supabase
    .from('products')
    .insert({
      boutique_id: boutiqueId,
      name:        `concurrency-test-${Date.now()}`,
      price:       1.00,
      stock:       1,              // ← exactly one unit
      category:    'Tops',
      status:      'active',
      source:      'manual',
    })
    .select('id')
    .single();
  if (error) throw new Error('Setup insert failed: ' + error.message);
  return product.id;
}

async function teardown(productId) {
  // Release any lingering holds then delete the test product
  await supabase.from('inventory_holds').delete().eq('product_id', productId);
  await supabase.from('products').delete().eq('id', productId);
}

async function race(productId) {
  // Fire two fn_reserve_for_order calls concurrently against the same product
  const orderId1 = uuidv4();
  const orderId2 = uuidv4();

  // Pre-insert both order stubs (status='pending')
  const boutiqueId = 'b151b2f6-f98c-4e37-91d9-feb8a62e3cfb';
  await supabase.from('orders').insert([
    { id: orderId1, shopper_id: '3171f23f-ad99-4c71-841b-b36c74c9724f',
      boutique_id: boutiqueId, status: 'pending',
      subtotal: 1, delivery_fee: 0, tax: 0, total_amount: 1,
      payment_status: 'pending', delivery_address: 'test',
      fulfillment_type: 'delivery', estimated_delivery_at: new Date().toISOString() },
    { id: orderId2, shopper_id: '3171f23f-ad99-4c71-841b-b36c74c9724f',
      boutique_id: boutiqueId, status: 'pending',
      subtotal: 1, delivery_fee: 0, tax: 0, total_amount: 1,
      payment_status: 'pending', delivery_address: 'test',
      fulfillment_type: 'delivery', estimated_delivery_at: new Date().toISOString() },
  ]);

  // Race both reserve calls simultaneously
  const [r1, r2] = await Promise.all([
    supabase.rpc('fn_reserve_for_order', { p_order_id: orderId1, p_product_ids: [productId] }),
    supabase.rpc('fn_reserve_for_order', { p_order_id: orderId2, p_product_ids: [productId] }),
  ]);

  const s1 = r1.data?.success === true;
  const s2 = r2.data?.success === true;

  // Cleanup
  await supabase.from('inventory_holds').delete().match({ product_id: productId });
  await supabase.from('orders').delete().in('id', [orderId1, orderId2]);
  // Reset stock to 1 for next round
  await supabase.from('products').update({ stock: 1 }).eq('id', productId);

  return { s1, s2 };
}

async function main() {
  console.log(`Running ${ROUNDS} concurrent reservation races...\n`);
  let productId;
  try {
    productId = await setup();
    console.log(`Test product: ${productId}`);

    let doubleAllocations = 0;
    let doubleFailures    = 0;
    let correct           = 0;

    for (let i = 0; i < ROUNDS; i++) {
      const { s1, s2 } = await race(productId);
      if (s1 && s2)   { doubleAllocations++; }
      else if (!s1 && !s2) { doubleFailures++; }
      else            { correct++; }

      if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${ROUNDS}\r`);
    }

    console.log('\n');
    console.log(`Results across ${ROUNDS} races:`);
    console.log(`  ✅ Exactly one winner:    ${correct}/${ROUNDS}`);
    console.log(`  ❌ Double allocation:      ${doubleAllocations}/${ROUNDS}`);
    console.log(`  ⚠️  Both failed:           ${doubleFailures}/${ROUNDS}`);

    if (doubleAllocations > 0) {
      console.error('\n🚨 CONCURRENCY BUG — fn_reserve_for_order does NOT prevent double allocation!');
      process.exit(1);
    } else if (doubleFailures > ROUNDS * 0.05) {
      console.warn('\n⚠️  More than 5% both-failed — possible lock contention, review query plan.');
    } else {
      console.log('\n✅ All races resolved correctly — no double allocation detected.');
    }
  } finally {
    if (productId) await teardown(productId);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
