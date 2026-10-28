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
    resumeStoppedSession(session);
    await configureQueueBatching(session);
    const scope = {};
    const previous = new Set([...session.agent.peekSteeringQueue(), ...session.agent.peekFollowUpQueue()]);
    const initialMessageCount = session.agent.state.messages.length;
    let delivered = false;
    const { promise: acceptance, resolve, reject } = Promise.withResolvers();
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
      unsubscribe();
      finishAdmission();
      if (admissionFlights.get(session) === admissionFinished) admissionFlights.delete(session);
    }
  }
`
