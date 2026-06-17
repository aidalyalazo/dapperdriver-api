/**
 * Lightweight load test for the DapperDriver API.
 *
 * Measures latency + throughput under concurrency against a READ-ONLY endpoint.
 * Usage:
 *   node scripts/loadtest.js [endpoint] [concurrency] [totalRequests]
 *   node scripts/loadtest.js /api/v1/boutiques?limit=20 40 200
 *
 * NOTE: the API rate-limits 200 req / 15 min PER IP, so a single-machine run
 * caps out there — useful for latency-under-concurrency, not full saturation.
 * For a true saturation test, raise the limit (or key it by user) and drive
 * load from multiple IPs (k6/artillery) against a staging deploy.
 */
const BASE = process.env.API_BASE || 'https://dapperdriver-api-production.up.railway.app';
const endpoint = process.argv[2] || '/api/v1/boutiques?limit=20';
const concurrency = parseInt(process.argv[3] || '40', 10);
const total = parseInt(process.argv[4] || '200', 10);

const url = BASE + endpoint;
const latencies = [];
let ok = 0, rateLimited = 0, errors = 0, done = 0;

async function oneRequest() {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const ms = Date.now() - t0;
    latencies.push(ms);
    if (res.status === 200) ok++;
    else if (res.status === 429) rateLimited++;
    else errors++;
  } catch (e) {
    errors++;
    latencies.push(Date.now() - t0);
  } finally {
    done++;
  }
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

(async () => {
  console.log(`Load test → ${url}`);
  console.log(`concurrency=${concurrency}  total=${total}\n`);
  const wallStart = Date.now();

  // Worker pool: each worker pulls from a shared counter until `total` reached.
  let issued = 0;
  async function worker() {
    while (issued < total) { issued++; await oneRequest(); }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const wallMs = Date.now() - wallStart;
  const rps = (done / (wallMs / 1000)).toFixed(1);
  console.log(`completed ${done} requests in ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`throughput: ${rps} req/s`);
  console.log(`success(200): ${ok}   rateLimited(429): ${rateLimited}   errors: ${errors}`);
  console.log(`latency ms — p50: ${pct(latencies, 50)}  p95: ${pct(latencies, 95)}  p99: ${pct(latencies, 99)}  max: ${Math.max(...latencies)}`);
})();
