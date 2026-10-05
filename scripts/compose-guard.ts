/**
 * docker compose never runs from a linked git worktree (a parallel agent's
 * copy of the repository). compose.yaml names the project `arianna`, so `up`
 * from a worktree recreated the main container on the worktree's empty
 * data/postgres, and the running core lost its database (2026-10-05). In a
 * worktree `up` does nothing: the main folder's database, already running on
 * the same port, serves the tests; any other command is refused.
 */
export type ComposeGuard = { run: true } | { run: false; exitCode: number; message: string };

export function composeGuard(gitDir: string, commonDir: string, args: readonly string[]): ComposeGuard {
  // In the main folder git-dir and git-common-dir are the same; in a linked worktree git-dir is .git/worktrees/<name>.
  if (gitDir === commonDir) return { run: true };
  if (args[0] === 'up') {
    return { run: false, exitCode: 0, message: "docker compose: in a git worktree the database is the main folder's; not recreated (start it there with pnpm db:up)" };
  }
  return { run: false, exitCode: 1, message: `docker compose ${args[0] ?? ''}: refused in a git worktree; run it from the main folder` };
}
