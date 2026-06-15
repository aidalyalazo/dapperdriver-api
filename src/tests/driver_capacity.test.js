/**
 * Unit test: driver capacity gating (multi-pickup batching).
 *
 * Proves getDriverActiveOrderCount + driverHasCapacity respect
 * max_active_orders, and that the default of 1 reproduces the old
 * single-order-per-driver behavior.
 *
 * No database needed — the supabase + fcm modules are stubbed in the
 * require cache before the service loads.
 *
 * Run:  node src/tests/driver_capacity.test.js
 */

const assert = require('node:assert');
const path = require('path');

// ── Stub config/supabase: .in() resolves to the count we set per case ──────────
let stubbedCount = 0;
const chain = {
  from() { return this; },
  select() { return this; },
  eq() { return this; },
  in() { return Promise.resolve({ count: stubbedCount }); },
};
const supabasePath = require.resolve(path.join(__dirname, '../config/supabase'));
require.cache[supabasePath] = {
  id: supabasePath, filename: supabasePath, loaded: true,
  exports: { supabaseAdmin: chain },
};

// ── Stub fcmService so requiring the service doesn't init Firebase ─────────────
const fcmPath = require.resolve(path.join(__dirname, '../services/fcmService'));
require.cache[fcmPath] = {
  id: fcmPath, filename: fcmPath, loaded: true,
  exports: { sendOrderNotification: async () => {}, notifyAvailableDrivers: async () => {} },
};

const { getDriverActiveOrderCount, driverHasCapacity } =
  require('../services/driverAssignmentService');

async function run() {
  let passed = 0;
  const check = async (name, fn) => {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  };

  // getDriverActiveOrderCount returns the raw count
  await check('active count reflects orders table count', async () => {
    stubbedCount = 3;
    assert.strictEqual(await getDriverActiveOrderCount('d1'), 3);
    stubbedCount = 0;
    assert.strictEqual(await getDriverActiveOrderCount('d1'), 0);
  });

  // Default capacity (max_active_orders undefined → treated as 1)
  await check('default max=1: idle driver has capacity', async () => {
    stubbedCount = 0;
    assert.strictEqual(await driverHasCapacity({ id: 'd1' }), true);
  });
  await check('default max=1: driver with 1 active order is full', async () => {
    stubbedCount = 1;
    assert.strictEqual(await driverHasCapacity({ id: 'd1' }), false);
  });

  // Explicit higher capacity
  await check('max=3: 2 active orders → still has capacity', async () => {
    stubbedCount = 2;
    assert.strictEqual(await driverHasCapacity({ id: 'd1', max_active_orders: 3 }), true);
  });
  await check('max=3: 3 active orders → full', async () => {
    stubbedCount = 3;
    assert.strictEqual(await driverHasCapacity({ id: 'd1', max_active_orders: 3 }), false);
  });
  await check('max=3: 4 active orders → full (never negative capacity)', async () => {
    stubbedCount = 4;
    assert.strictEqual(await driverHasCapacity({ id: 'd1', max_active_orders: 3 }), false);
  });

  console.log(`\n${passed}/6 capacity checks passed`);
}

run().then(() => {
  console.log('✅ driver_capacity.test.js passed');
  process.exit(0);
}).catch((e) => {
  console.error('❌ driver_capacity.test.js FAILED:', e.message);
  process.exit(1);
});
