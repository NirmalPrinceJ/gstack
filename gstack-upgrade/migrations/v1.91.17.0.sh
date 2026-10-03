#!/usr/bin/env bash
# Migration: v1.91.17.0 — severe fix wave (memory ingest).
# Placeholder name: the release queue may rename this file at /ship.
#
# Each step is independent and guarded. Idempotent and non-fatal: every path
# exits 0, and no step calls gbrain or the network unless it has work to do.
set -u
_gstack_migration_dir="${BASH_SOURCE[0]//\\//}"; _gstack_migration_dir="${_gstack_migration_dir%/*}"
. "${_gstack_migration_dir}/../../bin/gstack-state-root.sh" 2>/dev/null || { echo "$0: cannot resolve the gstack state root: ${_gstack_migration_dir}/../../bin/gstack-state-root.sh is missing. fix: reinstall with ./setup or /gstack-upgrade (docs/state-root.md)" >&2; exit 1; }
gstack_state_root_select; GH="$_gstack_sr_root"

# Step 1 (A1, #2778): older versions could mark a transcript ingested that
# gbrain had skipped. Record that a reconcile pass is pending; the next memory
# ingest re-checks stamped pages in bounded batches and re-queues the missing
# ones. This only writes a flag under the ingest's state lock; it never calls
# gbrain.
if [ -f "$GH/.transcript-ingest-state.json" ]; then
  INGEST="${_gstack_migration_dir}/../../bin/gstack-memory-ingest.ts"
  if command -v bun >/dev/null 2>&1 && [ -f "$INGEST" ]; then
    if bun "$INGEST" --request-reconcile --quiet; then
      echo "memory ingest: reconcile pending; the next /sync-gbrain re-checks transcripts already marked ingested."
    else
      echo "memory ingest: could not record a pending reconcile now; run: gstack-memory-ingest --reconcile" >&2
    fi
  fi
fi

exit 0
