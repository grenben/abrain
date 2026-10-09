/** Engine-free jobs help, shared by command dispatch and help output. */
export const JOBS_HELP = `gbrain jobs — Minions job queue

USAGE
  gbrain jobs authorize-legacy --ids 12,34 [--expect <snapshot_digest> --yes] [--json]
  gbrain jobs authorize-legacy --select "status=waiting|paused,name=synthesize" [--expect <hash> --yes] [--json]
  gbrain jobs submit <name> [--params JSON] [--follow] [--priority N]
                            [--delay Nms] [--max-attempts N] [--max-stalled N]
                            [--max-waiting N]
                            [--backoff-type fixed|exponential] [--backoff-delay Nms]
                            [--backoff-jitter 0..1] [--timeout-ms Nms]
                            [--lock-duration-ms Nms]
                            [--idempotency-key K] [--queue Q] [--dry-run]
                            [--yes] [--max-usd USD|off]  (enrich, subagent: paid)
                            [--codex-max-attempts N] [--codex-max-turns N]
                            [--codex-deadline UTC_ISO] (private generation only;
                              all three required; --max-usd separately caps API calls)
                            [--redact-secrets]   (shell only; scrubs inherit
                                                  values from stdout/stderr)
  gbrain jobs list [--status S] [--queue Q] [--limit N] [--json]
  gbrain jobs list --group SPEND_GROUP [--json]
  gbrain jobs get <id> [--json]
  gbrain jobs cancel <id> | --group SPEND_GROUP
  gbrain jobs cancel --select "status=waiting|paused,name=synthesize" [--expect <hash> --yes] [--json]
  gbrain jobs retry <id>
  gbrain jobs prune [--older-than 30d] [--dry-run]
  gbrain jobs delete <id>
  gbrain jobs stats [--queue Q] [--cluster-errors] [--json]
                    (dream-inline-* queues report ABANDONED/live only with an
                     explicit --queue; use \`gbrain doctor\` to discover them)
  gbrain jobs smoke [--sigkill-rescue] [--wedge-rescue]
  gbrain jobs watch [--json] [--follow] [--refresh-ms=N]
  gbrain jobs work [--queue Q] [--concurrency N] [--max-rss MB]
                   [--health-interval MS] [--nice N]
                   [--job-isolation inline|process]
  gbrain jobs supervisor [start] [--detach] [--json]
                         [--concurrency N] [--queue Q] [--pid-file PATH]
                         [--max-crashes N] [--health-interval N]
                         [--allow-shell-jobs] [--cli-path PATH]
                         [--max-rss MB] [--nice N]
                         [--job-isolation inline|process]

    --nice N   OS scheduling priority, -20 (highest) to 19 (nicest). Lowers CPU
               priority without cutting concurrency — full throughput when the
               box is idle, yields to foreground work when it's busy. Propagates
               to spawned workers and their children. Env: GBRAIN_NICE (flag
               wins). Effective value shows in 'jobs stats' and 'gbrain doctor'.
               Negative values need root.
  gbrain jobs supervisor status [--json] [--pid-file PATH]
  gbrain jobs supervisor stop [--json] [--pid-file PATH]

    Auto-restarting wrapper around 'gbrain jobs work'. Spawns the worker
    as a child process and restarts on crash with exponential backoff
    (1s -> 60s cap). Writes a brain-scoped PID file to
    ~/.gbrain/supervisor-<brain-id>.pid by default (override via
    --pid-file or GBRAIN_SUPERVISOR_PID_FILE env).
    Lifecycle events are appended to
      \${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl

    SUBCOMMANDS
      start        (default) Launch the supervisor. --detach returns a
                   JSON {event, supervisor_pid, pid_file} payload on
                   stdout and forks; omit for foreground.
      status       Read PID file + audit log, report running / last_start
                   / crashes_24h / max_crashes_exceeded as JSON or human.
                   Exits 0 if running, 1 if not.
      stop         Send SIGTERM to the supervisor, wait up to 45s for
                   graceful drain, report outcome (--queue names the
                   queue lock to verify when the audit log cannot).
                   Exits 0 only on a verified drain: the supervisor's own
                   stopped row says drained, its workers are gone and its
                   lock is released; otherwise exits 1 naming the check.

    EXIT CODES (start)
      0  clean shutdown (SIGTERM/SIGINT received, worker drained)
      1  max crashes exceeded (worker kept dying)
      2  another supervisor holds the PID lock
      3  PID file unwritable (permission / path error)

    EXAMPLES
      gbrain jobs supervisor --concurrency 4         # foreground (Ctrl-C stops)
      gbrain jobs supervisor start --detach --json   # agent-friendly: fork + return JSON
      gbrain jobs supervisor status --json           # machine-readable health check
      gbrain jobs supervisor stop                    # graceful stop
      gbrain jobs supervisor --json --allow-shell-jobs  # JSONL events + shell-exec on

HANDLER TYPES (built in)
  sync              Pull and embed new pages from the repo
  embed             (Re-)embed pages; --params '{"slug":...}' or '{"all":true}'
  lint              Run page linter; --params '{"dir":"...","fix":true}'
  import            Bulk import markdown; --params '{"dir":"..."}'
  extract           Extract links + timeline entries; '{"mode":"all"}'
  backlinks         Check or fix back-links; '{"action":"fix"}'
  autopilot-cycle   One autopilot pass (sync+extract+embed+backlinks)
  shell             Run a command or argv. Requires --allow-shell-jobs (or
                    GBRAIN_ALLOW_SHELL_JOBS=1) on the worker. Params: {cmd?,
                    argv?, cwd, env?}. See: docs/guides/minions-shell-jobs.md

Detailed help: gbrain jobs {work|supervisor|submit|watch|prune} --help
Other subcommands are fully described above.
`;
