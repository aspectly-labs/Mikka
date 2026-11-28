// `--test-force-exit` calls process.exit() in the `node --test` orchestrator
// as soon as its reporter has handed the last chunk to process.stdout. A piped
// stdout is asynchronous, so whatever is still queued there, including the
// `ℹ tests` summary, is lost and the process exits 0. A blocking handle makes
// every write finish before the next one starts, so nothing is left at exit.
//
// This must be a CommonJS `--require` preload: the orchestrator never evaluates
// `--import` modules (it only forwards them to the per-file child processes),
// and it is the orchestrator's stdout the db runner reads.
for (const stream of [process.stdout, process.stderr]) {
  stream._handle?.setBlocking?.(true)
}
