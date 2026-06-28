/**
 * Fetch EVERY matching row, past PostgREST's 1000-row default cap, by paging .range().
 *
 * Used for aggregations (SUM/AVG over a whole result set) that previously read only the
 * first 1000 rows and silently under-reported once an entity crossed that threshold
 * (#15/#16/#17). Counts don't need this — use `{ count: 'exact', head: true }` for those.
 *
 * `buildQuery` MUST be a thunk that returns a FRESH PostgREST query each call (a query
 * builder can't be re-ranged after it's been awaited), e.g.:
 *   fetchAllRows(() => supabaseAdmin.from('orders').select('x').eq('y', z))
 *
 * Returns the same `{ data, error }` shape as a normal query so callers stay unchanged.
 */
async function fetchAllRows(buildQuery, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: all, error };
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return { data: all, error: null };
}

module.exports = { fetchAllRows };
