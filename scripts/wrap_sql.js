/**
 * Rewrites RUN_IN_SUPABASE.sql so every statement runs inside its own
 * DO block with exception handling. A statement that doesn't match the
 * live schema (missing table/column) or is already applied gets skipped
 * with a NOTICE instead of aborting the entire paste.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'RUN_IN_SUPABASE.sql');
const raw = fs.readFileSync(file, 'utf8');

// Drop comment-only lines so splitting on ';' is safe
const lines = raw.split('\n').filter((l) => !l.trim().startsWith('--'));
const statements = lines
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const header = `-- ============================================================================
-- DapperDriver — ALL PENDING SQL (fault-tolerant edition)
-- Paste the ENTIRE file into the Supabase SQL Editor and Run.
--
-- Every statement is wrapped so a schema mismatch (a table or column that
-- doesn't exist in your database) is SKIPPED with a NOTICE instead of
-- aborting the whole run. Already-applied statements are skipped the same
-- way. After running, open the Messages panel to see what was skipped.
-- Safe to re-run any number of times.
-- ============================================================================

`;

const wrapped = statements.map((stmt) => {
  const tag = stmt.includes('$stmt$') ? '$stmtx$' : '$stmt$';
  return [
    'DO $run$ BEGIN',
    `  EXECUTE ${tag}${stmt}${tag};`,
    'EXCEPTION',
    '  WHEN undefined_column OR undefined_table OR undefined_object',
    '    OR duplicate_object OR duplicate_table OR duplicate_column THEN',
    "    RAISE NOTICE 'SKIPPED: %', SQLERRM;",
    'END $run$;',
  ].join('\n');
}).join('\n\n');

fs.writeFileSync(file, header + wrapped + '\n');
console.log('Wrapped statements:', statements.length);
