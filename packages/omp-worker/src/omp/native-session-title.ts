import { nativeTitleCardPrompt, nativeTitleForkPrompt } from './native-title-prompts.js'

export const SESSION_TITLE_PREFIX = '\u001eompiui-session-title:'

export const nativeSessionTitleImports = String.raw`
import { operatorTitleText as nstOperatorText, buildReplanTitleContext as nstContext, titleContextWordCount as nstWords } from "@oh-my-pi/pi-coding-agent/session/messages";
import { cfgTitleGenerator as nstGenerator, cfgTitleIcons as nstIcons, cfgTitleRefreshOnReplan as nstRefresh } from "@oh-my-pi/pi-coding-agent/utils/title-settings";
import { parseCardTitleReply as nstParseTitle, parseCardReply as nstParseCard, splitCardTitle as nstSplitCard, formatCardTitle as nstFormatCard, keepTitleCard as nstKeepCard } from "@oh-my-pi/pi-coding-agent/utils/title-card";
import { prompt as nstPrompt } from "@oh-my-pi/pi-utils";
`;

// Host the official title methods on the existing RPC session. Never replace the
// session, change the CLI's global PI_NO_TITLE flag, or run inference in the worker.
export const nativeSessionTitleSource = String.raw`
  const nstPrefix = ${JSON.stringify(SESSION_TITLE_PREFIX)};
  const titleForkPrompt = ${JSON.stringify(nativeTitleForkPrompt)};
  const titleCardPrompt = ${JSON.stringify(nativeTitleCardPrompt)};
  const nstEnabled = globalThis.process?.env?.OMPIUI_AUTO_TITLE_ENABLED === "1";
  const nstModuleKey = Symbol.for("ompiui.nativeSessionTitle");
  const nstOwners = globalThis[nstModuleKey] ??= new WeakMap();
  let nstDisposed = false;
  let nstBinding = null;
  function nstStop() {
    const binding = nstBinding;
    nstBinding = null;
    if (!binding) return;
    binding.closed = true;
    binding.controller.abort();
    binding.unsubscribe?.();
    if (nstOwners.get(binding.manager) === binding.dispose) nstOwners.delete(binding.manager);
  }
  function nstCurrent(binding) {
    return nstBinding === binding && !binding.closed &&
      binding.manager.getSessionId() === binding.id &&
      binding.manager.getSessionFile() === binding.file;
  }
  function nstPublish(binding) {
    if (!nstCurrent(binding)) return;
    binding.ctx.ui.notify(nstPrefix + JSON.stringify({
      type: "session_info_update", sessionId: binding.id,
      title: binding.manager.getSessionName(),
    }), "info");
  }
  function nstBind(ctx) {
    if (nstDisposed) return null;
    const session = ownSession(ctx);
    const manager = session.sessionManager;
    if (nstBinding?.session === session && nstCurrent(nstBinding)) {
      nstBinding.ctx = ctx;
      return nstBinding;
    }
    nstStop();
    const ref = pi.pi.AgentRegistry.global().list().find(ref => ref.session === session);
    if (ref?.kind === "sub" || ref?.kind === "advisor" || ref?.parentId) return null;
    const binding = {
      session, manager, ctx, id: manager.getSessionId(), file: manager.getSessionFile(),
      controller: new AbortController(), closed: false, input: null, flight: null,
      deferred: null, unsubscribe: null,
      dispose: () => { nstDisposed = true; nstStop(); },
    };
    nstOwners.get(manager)?.();
    nstOwners.set(manager, binding.dispose);
    nstBinding = binding;
    binding.unsubscribe = manager.onSessionNameChanged(() => nstPublish(binding));
    return binding;
  }
  function nstSignal(binding) {
    return AbortSignal.any([binding.controller.signal, binding.session.titleGenerationSignal]);
  }
  function nstCards(binding) {
    return nstGenerator.get(binding.session.settings) === "fork" && binding.session.titleSystemPrompt === undefined;
  }
  function nstIconStyle(binding) {
    const style = nstIcons.get(binding.session.settings);
    // GUI uses the emoji, not terminal-specific Nerd Font glyphs.
    return style === "nf+emoji" ? "emoji" : style;
  }
  async function nstCard(binding, title, signal) {
    const icons = nstIconStyle(binding);
    if (!title || icons === "boring" || nstSplitCard(title)) return title;
    const reply = await binding.session.generateTitle(title, nstPrompt.render(titleCardPrompt, { nerdFonts: false }), signal);
    const card = reply && nstParseCard(reply, icons);
    return card ? nstFormatCard(card, title) : title;
  }
  async function nstGenerate(binding, input, signal, replan, retry) {
    const session = binding.session;
    if (!replan && !retry && nstCards(binding) && session.model) {
      try {
        const result = await session.runEphemeralTurn({
          promptText: nstPrompt.render(titleForkPrompt, { card: nstIconStyle(binding) !== "boring", nerdFonts: false }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        const title = nstParseTitle(result.replyText, nstIconStyle(binding), input);
        if (title && !signal.aborted) return await nstCard(binding, title, signal);
      } catch (error) {
        if (signal.aborted) return null;
      }
    }
    if (signal.aborted || (!replan && nstAttachmentOnly(input))) return null;
    const title = await session.generateTitle(input, undefined, signal);
    const named = replan && title ? nstKeepCard(session.sessionName, title) : title;
    return named && nstCards(binding) ? await nstCard(binding, named, signal) : named;
  }
  function nstStart(binding, input, replan = false, retry = false) {
    if (!nstEnabled || !nstCurrent(binding) || binding.flight || binding.manager.titleSource === "user") return;
    if (!replan && binding.session.sessionName) return;
    const signal = nstSignal(binding);
    const nativeSignal = binding.session.titleGenerationSignal;
    const requestInput = binding.input;
    const revision = binding.manager.titleRevision;
    const deferred = replan || retry ? null : { declined: false, replied: false, words: 0 };
    if (deferred) binding.deferred = deferred;
    // Starting the native side turn synchronously snapshots the streaming reply;
    // no await here can hold up the main prompt or its tool events.
    const flight = nstGenerate(binding, input, signal, replan, retry)
      .then(async title => {
        if (!title || signal.aborted || !nstCurrent(binding)) return;
        if (binding.manager.titleRevision !== revision || binding.manager.titleSource === "user") return;
        if (!replan && binding.session.sessionName) return;
        if (replan && !nstRefresh.get(binding.session.settings)) return;
        await binding.manager.setSessionName(title, "auto", replan ? "replan" : undefined);
      })
      .catch(error => {
        if (!signal.aborted && nstCurrent(binding)) binding.ctx.ui.notify("Automatic session title failed: " + (error instanceof Error ? error.message : String(error)), "warning");
      })
      .finally(() => {
        if (binding.flight === flight) binding.flight = null;
        if (!nstCurrent(binding)) return;
        if (signal.aborted) {
          if (binding.deferred === deferred) binding.deferred = null;
          if (binding.input === requestInput && binding.input) { binding.input.tried = false; binding.input.replied = false; }
          if (binding.input !== requestInput && binding.session.titleGenerationSignal !== nativeSignal) nstMaybeStart(binding);
          return;
        }
        if (deferred && binding.deferred === deferred) deferred.declined = !binding.session.sessionName;
        if (!nstMaybeStart(binding)) nstAdvance(binding);
      });
    binding.flight = flight;
  }
  // The native host does not export tiny/text to extensions. Match its input
  // eligibility here; native generateTitle still owns model input preprocessing.
  const nstFiller = new Set("hi hii hiii hiya hey heya hello helo hullo yo ya sup wassup whatsup whats howdy greetings hola ciao aloha gm gn good morning afternoon evening night day thanks thank thx ty tysm cheers please pls plz ok okay okey k kk yep yes yeah yup nope no nah sure cool nice great awesome perfect lol lmao haha hehe test tests testing ping pong there you u hmm hmmm um uh so well anyway".split(" "));
  function nstClean(text) {
    if (/^\s*<chat>[\s\S]*<\/chat>\s*$/.test(text)) return text.replace(/<\/?(?:chat|user|assistant|think)>/g, " ");
    const raw = text.replace(/\u001b\[[0-9;]*m/g, "");
    const stripped = raw.replace(/\x60{3,}[\s\S]*?(?:\x60{3,}|$)/g, " ").trim();
    return (stripped.length >= 12 ? stripped : raw)
      .replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, " ")
      .replace(/\b[0-9a-fA-F]{12,}\b/g, hash => hash.slice(0, 7));
  }
  function nstHasSignal(text) {
    const tokens = nstClean(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return tokens.some(token => !nstFiller.has(token) && !/^\d+$/.test(token));
  }
  function nstAttachmentOnly(text) {
    const without = text.replace(/\[(?:Image|Video) #\d+[^\]]*\]/g, " ");
    if (without === text) return false;
    const pointers = new Set("fix this that these those it here look at see check investigate what whats s is are why do does i we get wrong broken break did help can could the a thing issue bug me now again still oh".split(" "));
    return (nstClean(without).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every(token => nstFiller.has(token) || pointers.has(token));
  }
  function nstMaybeStart(binding) {
    const input = binding.input;
    if (!input?.replied || input.tried || binding.flight || binding.session.sessionName) return false;
    input.tried = true;
    nstStart(binding, input.text);
    return true;
  }
  function nstAdvance(binding) {
    const deferred = binding.deferred;
    if (!deferred || binding.flight || !deferred.declined || !deferred.replied) return;
    binding.deferred = null;
    if (binding.session.sessionName) return;
    const context = nstContext(binding.session.agent.state.messages);
    if (context && nstHasSignal(context)) nstStart(binding, context, false, true);
  }
  function nstReplan(binding) {
    if (binding.flight) return;
    if (!nstRefresh.get(binding.session.settings) || binding.manager.titleSource === "user") return;
    const context = nstContext(binding.session.agent.state.messages);
    if (context && nstHasSignal(context)) nstStart(binding, context, true);
  }
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => nstBind(ctx));
    pi.on("session_shutdown", () => { nstDisposed = true; nstStop(); });
    pi.on("message_end", (event, ctx) => {
      const binding = nstBind(ctx);
      if (!binding) return;
      const text = nstOperatorText(event.message);
      const command = text?.startsWith("/") ? text.slice(1).split(/\s/, 1)[0] : null;
      const localCommand = command && pi.getCommands().some(entry => entry.name === command);
      if (text && nstEnabled && nstHasSignal(text) && !binding.session.sessionName && !localCommand) {
        binding.input = { text, replied: false, tried: false };
      } else if (event.message.role === "assistant" && binding.deferred) {
        binding.deferred.words += nstWords(event.message);
        if (binding.deferred.words >= 40) binding.deferred.replied = true;
        nstAdvance(binding);
      }
    });
    pi.on("message_update", (event, ctx) => {
      const binding = nstBind(ctx);
      const kind = event.assistantMessageEvent?.type;
      if (binding?.input && (kind === "text_start" || kind === "toolcall_start")) {
        binding.input.replied = true;
        nstMaybeStart(binding);
      }
    });
    pi.on("tool_result", (event, ctx) => {
      if (event.toolName !== "todo" || event.isError || event.input?.op !== "init") return;
      const binding = nstBind(ctx);
      if (binding) nstReplan(binding);
    });
  }
`;
