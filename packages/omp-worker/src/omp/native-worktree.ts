/** Public SDK-only relocation; no InteractiveMode/controller imports. */
export const NATIVE_WORKTREE_IMPORTS = `
import path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
`;
export const NATIVE_WORKTREE_SOURCE = `
  function assertWorktreeIdle(session, ctx) {
    const jobs = ctx.getAsyncJobSnapshot();
    const activeJobs = (jobs?.running.length ?? 0) > 0;
    if (session.isStreaming || session.isCompacting || session.isRetrying || session.hasAdmittedSubmission || session.hasPendingAsyncWork() ||
        ctx.hasPendingMessages() || admissionFlights.has(session) || session.agent.peekSteeringQueue().length || session.agent.peekFollowUpQueue().length || activeJobs) {
      throw Object.assign(new Error("Wait for native prompts, queues, and background jobs to settle before switching worktrees. Nothing was moved."), { code: "SESSION_BUSY" });
    }
  }
  async function rescopeWorktree(session, cwd) {
    setProjectDir(cwd);
    await session.settings.reloadForCwd(cwd);
    await rebindMemoryBackendForCwd(session);
    clearClaudePluginRootsCache();
    await session.refreshSkillsAndCommands();
  }
  async function moveWorktreeSession(session, args, ctx) {
    assertWorktreeIdle(session, ctx);
    if (typeof args.path !== "string" || !args.path) throw new Error("A worktree path is required");
    const sourceCwd = session.sessionManager.getCwd();
    const target = path.resolve(sourceCwd, args.path);
    const repository = vcs.requireGit(sourceCwd);
    const worktrees = await repository.worktrees();
    const compare = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!worktrees.some(tree => compare(tree.path) === compare(target))) throw new Error("Target is no longer a worktree of this repository");
    if (compare(sourceCwd) === compare(target)) return { ...identity(session), cancelled: false, noOp: true };
    assertWorktreeIdle(session, ctx);
    // The worker backed up latest disk bytes before this explicit write. Reload
    // the native history through its public API, not a private session copy.
    if (session.sessionManager.isSessionOnDisk()) await session.reload();
    assertWorktreeIdle(session, ctx);
    await session.settings.flush();
    assertWorktreeIdle(session, ctx);
    const before = session.sessionManager.captureState();
    await session.moveSession(target);
    try {
      await rescopeWorktree(session, target);
    } catch (error) {
      try {
        await session.sessionManager.rollbackMove(before);
        await rescopeWorktree(session, sourceCwd);
      } catch (rollbackError) {
        // Never hide a committed move behind a retriable failure: publish where
        // the authoritative native manager now points and preserve its journal.
        return { ...identity(session), cancelled: false, projectionError: String(error) + "; rollback: " + String(rollbackError) };
      }
      throw error;
    }
    return { ...identity(session), cancelled: false };
  }
`;
