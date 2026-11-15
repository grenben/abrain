/** Bind the namespace supervisor to its GBrain parent, including startup races.
 * setpriv installs the kernel parent-death signal before the shell checks PPID.
 * The fixed shell then execs unshare, retaining that signal; --kill-child binds
 * the namespace init to unshare, whose death tears down every descendant.
 */
export function codexNamespaceLaunch(executable: string, args: readonly string[], launcher = '/usr/bin/unshare') {
  return { command: '/usr/bin/setpriv', args: [
    '--pdeathsig', 'KILL', '--', '/usr/bin/dash', '-c',
    'test "$PPID" = "$1" || exit 125; shift; exec "$@"',
    'gbrain-codex-namespace', String(process.pid), launcher,
    '--user', '--map-root-user', '--pid', '--fork', '--kill-child', '--mount-proc',
    '--propagation', 'private', '--', executable, ...args,
  ] };
}
