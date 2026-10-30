/** Private notification channel consumed by the managed session coordinator. */
export const SUBAGENT_OBSERVATION_PREFIX = 'ompiui-subagent-observation:'

export interface SubagentObservationPayload {
  protocolVersion: 1
  rootSessionId: string
  rootSessionFile: string | null
  id: string
  sessionFile: string | null
  /** Local observer lifetime, not a native task run identifier. */
  observationEpoch: string
  /** Local attachment generation, not a native task run identifier. */
  observationId: string
  activityVersion: number
  /** Monotonic publication order across roots, attachments and module reloads. */
  observationSequence: number
  activity: 'running' | 'idle' | 'unavailable'
  pendingAsync: boolean
  removed?: boolean
}

/** One module generation may be bound to both the root and inherited children. */
export const nativeSubagentObservationPrelude = String.raw`
const subagentObservationKey = Symbol.for("ompiui.nativeSubagentObservation.v1");
const subagentObservationPrevious = globalThis[subagentObservationKey];
subagentObservationPrevious?.dispose();
const subagentObservationModule = {
  closed: false, observers: new Set(), roots: new Map(),
  sequence: subagentObservationPrevious?.sequence ?? 0,
  dispose() {
    this.closed = true;
    for (const dispose of [...this.observers]) dispose();
    this.observers.clear();
    this.roots.clear();
  },
};
globalThis[subagentObservationKey] = subagentObservationModule;
`;

/** Insert inside the generated public extension factory after ownSession. */
export const nativeSubagentObservationSource = String.raw`
  const subagentObservationPrefix = ${JSON.stringify(SUBAGENT_OBSERVATION_PREFIX)};
  const subagentObserver = { closed: subagentObservationModule.closed, generation: 0, ctx: null, registry: null, unsubscribe: null, timer: null, timerContext: null, root: null };
  const disposeSubagentObserver = () => stopSubagentObservation(true);
  if (!subagentObserver.closed) subagentObservationModule.observers.add(disposeSubagentObserver);
  function subagentRelease(unsubscribe) {
    try { unsubscribe?.(); } catch {}
  }
  function subagentDrop(record) {
    record.active = false;
    subagentRelease(record.unsubscribe);
    record.unsubscribe = null;
  }
  function subagentClearRoot() {
    if (subagentObserver.root) {
      const root = subagentObserver.root;
      for (const record of root.children.values()) subagentDrop(record);
      if (subagentObservationModule.roots.get(root.key) === disposeSubagentObserver) subagentObservationModule.roots.delete(root.key);
      subagentObserver.root = null;
    }
  }
  function stopSubagentObservation(closed = false) {
    subagentObserver.closed = closed;
    if (closed) subagentObservationModule.observers.delete(disposeSubagentObserver);
    subagentObserver.generation++;
    subagentClearRoot();
    subagentRelease(subagentObserver.unsubscribe);
    subagentObserver.unsubscribe = null;
    subagentObserver.registry = null;
    if (subagentObserver.timer !== null) {
      try { subagentObserver.timerContext.clearTimer(subagentObserver.timer); } catch {}
    }
    subagentObserver.timer = null;
    subagentObserver.timerContext = null;
    subagentObserver.ctx = null;
  }
  function subagentIdentity(session) {
    return { id: session.sessionManager.getSessionId(), file: session.sessionManager.getSessionFile() ?? null };
  }
  function subagentRootCurrent(root) {
    try {
      if (subagentObserver.closed || subagentObserver.root !== root || pi.pi.AgentRegistry.global() !== root.registry) return false;
      const session = ownSession(subagentObserver.ctx);
      const identity = subagentIdentity(session);
      return session === root.session && identity.id === root.id && identity.file === root.file
        && root.registry.list().includes(root.ref) && root.ref.session === session;
    } catch { return false; }
  }
  function subagentDescendants(root) {
    const byParent = new Map();
    for (const ref of root.registry.list()) {
      if (ref.kind !== "sub") continue;
      const children = byParent.get(ref.parentId) ?? [];
      children.push(ref);
      byParent.set(ref.parentId, children);
    }
    const descendants = new Map();
    const seen = new Set([root.ref.id]);
    const parents = [root.ref.id];
    for (let index = 0; index < parents.length; index++) {
      for (const ref of byParent.get(parents[index]) ?? []) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        descendants.set(ref.id, ref);
        parents.push(ref.id);
      }
    }
    return descendants;
  }
  function subagentAttachmentCurrent(record, ref) {
    try {
      if (ref !== record.ref || ref.session !== record.session || ref.sessionFile !== record.refFile) return false;
      if (!record.session) return true;
      const identity = subagentIdentity(record.session);
      return identity.id === record.sessionId && identity.file === record.file;
    } catch { return false; }
  }
  function subagentRecordCurrent(root, record) {
    return record.active && subagentRootCurrent(root) && root.children.get(record.ref.id) === record
      && subagentAttachmentCurrent(record, subagentDescendants(root).get(record.ref.id));
  }
  function subagentPublish(root, record, activity, pendingAsync, removed = false) {
    if (!subagentRootCurrent(root)) return;
    if (!removed && !subagentRecordCurrent(root, record)) return;
    if (!removed && record.activity === activity && record.pendingAsync === pendingAsync) return;
    record.activity = activity;
    record.pendingAsync = pendingAsync;
    const payload = {
      protocolVersion: 1, rootSessionId: root.id, rootSessionFile: root.file,
      id: record.ref.id, sessionFile: record.file, observationEpoch: root.epoch,
      observationId: record.observationId, activityVersion: ++record.version,
      observationSequence: ++subagentObservationModule.sequence,
      activity, pendingAsync, ...(removed ? { removed: true } : {}),
    };
    try { subagentObserver.ctx.ui.notify(subagentObservationPrefix + JSON.stringify(payload), "info"); } catch {}
  }
  function subagentSample(root, record) {
    if (!subagentRecordCurrent(root, record)) return;
    try {
      if (!record.session || typeof record.session.subscribeRunState !== "function"
        || typeof record.session.hasPendingAsyncWork !== "function" || !record.unsubscribe) {
        subagentPublish(root, record, "unavailable", false);
        return;
      }
      const pending = record.session.hasPendingAsyncWork();
      if (typeof pending !== "boolean" || (record.runActivity !== "running" && record.runActivity !== "idle")) {
        subagentPublish(root, record, "unavailable", false);
        return;
      }
      subagentPublish(root, record, record.runActivity, pending);
    } catch { subagentPublish(root, record, "unavailable", false); }
  }
  function subagentAttach(root, ref) {
    const session = ref.session;
    let identity;
    try { identity = session ? subagentIdentity(session) : null; } catch {}
    const record = {
      ref, session, refFile: ref.sessionFile, sessionId: identity?.id,
      file: identity ? identity.file : ref.sessionFile ?? null, active: true, unsubscribe: null,
      observationId: randomUUID(), version: 0, activity: null, pendingAsync: null, runActivity: null,
    };
    root.children.set(ref.id, record);
    try {
      if (session && typeof session.subscribeRunState === "function") {
        if (typeof session.isStreaming === "boolean") record.runActivity = session.isStreaming ? "running" : "idle";
        const unsubscribe = session.subscribeRunState(activity => {
          if (!subagentRecordCurrent(root, record) || (activity !== "running" && activity !== "idle")) return;
          record.runActivity = activity;
          subagentSample(root, record);
        });
        if (typeof unsubscribe === "function") record.unsubscribe = unsubscribe;
      }
    } catch {}
    subagentSample(root, record);
  }
  function reconcileSubagentObservation(ctx = subagentObserver.ctx) {
    if (subagentObserver.closed || !ctx) return;
    subagentObserver.ctx = ctx;
    try {
      const registry = pi.pi.AgentRegistry.global();
      if (registry !== subagentObserver.registry) {
        subagentClearRoot();
        subagentRelease(subagentObserver.unsubscribe);
        subagentObserver.registry = registry;
        subagentObserver.unsubscribe = null;
        if (typeof registry.onChange === "function") {
          const generation = subagentObserver.generation;
          subagentObserver.unsubscribe = registry.onChange(() => {
            if (!subagentObserver.closed && subagentObserver.generation === generation && subagentObserver.registry === registry) reconcileSubagentObservation();
          });
        }
      }
      // Exactly one managed, read-only poll. Silent attach/detach and pending
      // async changes do not emit registry events. No prompt/refresh operation.
      if (subagentObserver.timer === null && typeof ctx.setInterval === "function" && typeof ctx.clearTimer === "function") {
        const generation = subagentObserver.generation;
        subagentObserver.timerContext = ctx;
        subagentObserver.timer = ctx.setInterval(() => {
          if (!subagentObserver.closed && subagentObserver.generation === generation) reconcileSubagentObservation();
        }, 1000);
      }
      const session = ownSession(ctx);
      const identity = subagentIdentity(session);
      const ref = registry.list().find(candidate => candidate.session === session);
      if (!ref || ref.kind === "advisor") { subagentClearRoot(); return; }
      let root = subagentObserver.root;
      if (!root || root.ref !== ref || root.session !== session || root.id !== identity.id || root.file !== identity.file) {
        subagentClearRoot();
        const key = JSON.stringify([identity.id, identity.file]);
        subagentObservationModule.roots.get(key)?.();
        root = { registry, ref, session, key, id: identity.id, file: identity.file, epoch: randomUUID(), children: new Map() };
        subagentObserver.root = root;
        subagentObservationModule.roots.set(key, disposeSubagentObserver);
      }
      const descendants = subagentDescendants(root);
      for (const [id, record] of root.children) {
        const current = descendants.get(id);
        if (!current || current !== record.ref) {
          subagentPublish(root, record, "unavailable", false, true);
          subagentDrop(record);
          root.children.delete(id);
        } else if (!subagentAttachmentCurrent(record, current)) {
          subagentDrop(record);
          root.children.delete(id);
        }
      }
      for (const ref of descendants.values()) {
        const record = root.children.get(ref.id);
        if (record) subagentSample(root, record);
        else subagentAttach(root, ref);
      }
    } catch { subagentClearRoot(); }
  }
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => reconcileSubagentObservation(ctx));
    pi.on("session_shutdown", () => stopSubagentObservation(true));
  }
`;
