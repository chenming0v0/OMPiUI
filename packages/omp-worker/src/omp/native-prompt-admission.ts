// Executed inside the official OMP process; no worker-side prompt/queue runner.
export const NATIVE_PROMPT_ADMISSION_IMPORT = 'import { AsyncLocalStorage } from "node:async_hooks";'

export const NATIVE_PROMPT_ADMISSION_SOURCE = `
  const submissionScope = new AsyncLocalStorage();
  const admissionFlights = new WeakMap();
  async function submitUserMessage(session, args) {
    if (typeof args.text !== "string" || args.text.startsWith("/")) throw new Error("Native user submission requires non-command text");
    if (args.deliverAs !== "steer" && args.deliverAs !== "followUp") throw new Error("Invalid native delivery mode");
    const expectedId = session.sessionManager.getSessionId();
    const expectedFile = session.sessionManager.getSessionFile();
    const previousAdmission = admissionFlights.get(session);
    const { promise: admissionFinished, resolve: finishAdmission } = Promise.withResolvers();
    admissionFlights.set(session, admissionFinished);
    if (previousAdmission) await previousAdmission;
    if (session.sessionManager.getSessionId() !== expectedId || session.sessionManager.getSessionFile() !== expectedFile) {
      finishAdmission();
      if (admissionFlights.get(session) === admissionFinished) admissionFlights.delete(session);
      throw Object.assign(new Error("Session replaced while waiting for native admission"), { code: "SESSION_REPLACED" });
    }
    // 桥扩展是注入到官方进程里执行的源码，宿主可能与 worker 编译产物版本不一致；
    // 同作用域的辅助函数缺席时 typeof 不会抛，绝不能让一个可选优化挡住发消息
    // （线上曾因旧 dist 缺少 configureQueueBatching 定义而整条提交链路彻底发不出去）。
    if (typeof resumeStoppedSession === "function") resumeStoppedSession(session);
    if (typeof configureQueueBatching === "function") await configureQueueBatching(session);
    const scope = {};
    const previous = new Set([...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()]);
    const initialMessageCount = session.agent.state.messages.length;
    let delivered = false;
    const { promise: acceptance, resolve, reject } = Promise.withResolvers();
    // 一次卡住的提交不能永久占住会话的准入锁：官方 prompt 既不 resolve 也不
    // 发 agent_start 时 acceptance 永不结算，finally 就永不执行，之后每次提交
    // 都排在它后面直到 worker 的 30s 超时——「发一次失败，之后所有消息都发不
    // 出去」正是这条路径。给准入一个有界等待，超时即结算并释放锁。
    const admissionTimeoutMs = Number(process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS) > 0
      ? Math.floor(Number(process.env.OMPIUI_NATIVE_ADMISSION_TIMEOUT_MS))
      : 20_000;
    const admissionTimer = setTimeout(() => {
      reject(Object.assign(
        new Error("Native prompt admission timed out after " + admissionTimeoutMs + "ms; the submission lock was released and your draft is preserved"),
        { code: "SUBMISSION_NOT_ADMITTED" },
      ));
    }, admissionTimeoutMs);
    // 不能 unref：准入超时必须能把等待中的提交结算掉。unref 后事件循环一旦没有
    // 其它句柄就会先排空，挂住的提交既不会被释放也不会被拒绝（CI 上表现为
    // "Promise resolution is still pending but the event loop has already resolved"）。
    const assertIdentity = () => {
      if (session.sessionManager.getSessionId() !== expectedId || session.sessionManager.getSessionFile() !== expectedFile) {
        throw Object.assign(new Error("Session replaced before native message admission"), { code: "SESSION_REPLACED" });
      }
    };
    const accept = () => {
      if (delivered) return;
      try { assertIdentity(); } catch (error) { reject(error); return; }
      delivered = true;
      resolve({ accepted: true });
    };
    // Async context associates the raw native start with this prompt, not an
    // unrelated concurrent run. Busy-path queue insertion resolves prompt().
    const unsubscribe = session.agent.subscribe(event => {
      if (submissionScope.getStore() !== scope) return;
      if (event.type === "agent_start" || (event.type === "message_start" && isUserQueuedMessage(event.message))) accept();
    });
    const prompt = submissionScope.run(scope, () => session.prompt(args.text, {
      images: args.images,
      streamingBehavior: args.deliverAs,
    }));
    void prompt.then(agentInvoked => {
      if (delivered) return;
      assertIdentity();
      const newUserMessage = [...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue(), ...session.agent.state.messages.slice(initialMessageCount)]
        .some(message => !previous.has(message) && isUserQueuedMessage(message));
      if (agentInvoked === false || newUserMessage) accept();
      else reject(Object.assign(new Error("Native prompt was not admitted; your draft is preserved"), { code: "SUBMISSION_NOT_ADMITTED" }));
    }, error => { if (!delivered) reject(error); }).catch(reject);
    try { return await acceptance; } finally {
      clearTimeout(admissionTimer);
      unsubscribe();
      finishAdmission();
      if (admissionFlights.get(session) === admissionFinished) admissionFlights.delete(session);
    }
  }
`
