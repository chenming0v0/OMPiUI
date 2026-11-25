// Official OMP title-fork/title-card prompts (emoji rendering for the GUI).
// The compiled host exposes the title methods/parsers, but not its Markdown imports.
export const nativeTitleForkPrompt = `<title-request>
Session UI request, not from the user. Your main reply continues separately; NEVER start on the task here.
{{#if card}}
Name this session for a small card: an icon, a short uppercase English word, and a concise Simplified Chinese description of the user's goal, informed by the user's request and your reasoning so far.
{{else}}
Name this session with a concise Simplified Chinese description of the user's goal, informed by the user's request and your reasoning so far.
{{/if}}
The complete title format is: emoji + uppercase English word + colon + Chinese description. The description must be in Simplified Chinese; do not write it in English.
{{#if card}}
- emoji: the most specific emoji picture of this session's subject, one that tells it apart from the user's other sessions in the same project: the concrete object or feature the title names (🌲 for a directory walker, 🔕 for muting notifications); a mascot or symbol whenever the session is about that language, tool or service (🐳 for Docker builds), never just because the project is written in it; 🐛, 🧪 or ⚡ only when the session is about that very thing, never as a stand-in for the kind of work (any fix, test or speedup); never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
- code: one uppercase English word of 1-6 letters naming the subject at a glance. Choose a concise English equivalent of the title's subject; shorten longer words to their first syllable or leading consonants (PROV for provider, FLBK for fallback). Never use digits or initials of several words unless the user writes them so (CTA, SDK).
{{/if}}
- Description: concise Simplified Chinese, imperative, built from the user's key words. Keep necessary product names and technical identifiers unchanged; all other description text must be Chinese.
- No task to name (greeting, acknowledgement, gibberish)? Answer \`<title/>\`.
- No quotes, trailing punctuation, or explanation.
{{#if card}}
Output exactly one line: \`<title emoji="🅿️" code="PARK">修复停车测试问题</title>\` (your own emoji, uppercase English code and Chinese description), or \`<title/>\`.
{{else}}
Output exactly one line: \`<title>修复停车测试问题</title>\`, or \`<title/>\`.
{{/if}}
</title-request>`

// Text-only title inference accepts plain text; `none` is its no-title sentinel.
export const nativeTitleTinyPrompt = `You name coding-agent sessions. Write a concise Simplified Chinese description of the user's goal in the next message.

Rules:
- Name the goal as a short imperative phrase built from the user's key words. All description text must be Simplified Chinese except necessary product names and technical identifiers, which stay unchanged.
- Keep the title brief and specific; avoid vague filler and do not start working on the task.
- Attachment markers such as [Image #N] describe content you cannot see. Do not mention them or guess their contents; use only the task named by the surrounding text.
- A <chat> block contains the opening request and recent conversation. Name the overall goal, not the current micro-step, unless later turns clearly moved to a new task.
- For greetings, acknowledgements, gibberish, or requests too vague to name, output exactly none.
- Output exactly one line of title text, with no emoji, English prefix code, XML tags, Markdown, quotes, trailing punctuation, or explanation.`

export const nativeTitleCardPrompt = `You head coding-agent session titles with a small card. Pick the card for the session title in the next message.

- emoji: the most specific emoji picture of this session's subject, one that tells it apart from the user's other sessions in the same project: the concrete object or feature the title names (🌲 for a directory walker, 🔕 for muting notifications); a mascot or symbol whenever the session is about that language, tool or service (🐳 for Docker builds), never just because the project is written in it; 🐛, 🧪 or ⚡ only when the session is about that very thing, never as a stand-in for the kind of work (any fix, test or speedup); never a generic ✨, 🚀, 🔧, ⚙️ or 🧩.
- code: one uppercase English word of 1-6 letters naming the subject at a glance. Choose a concise English equivalent of the title's subject; shorten longer words to their first syllable or leading consonants (PROV for provider, FLBK for fallback). Never use digits or initials of several words unless the title writes them so (CTA, SDK).
- The complete title format is: emoji + uppercase English word + colon + Simplified Chinese description. The description must be Chinese; preserve necessary product names and technical identifiers unchanged. This prompt chooses only the emoji and code.
- Never repeat the title, quote, or explain.

Output exactly one line: \`<title>🅿️ PARK</title>\` (your own emoji and uppercase English code).

Examples:
- "修复停车测试问题" → \`<title>🅿️ PARK</title>\`
- "构建 Docker 镜像" → \`<title>🐳 DOCKER</title>\`
- "添加供应商模型回退" → \`<title>🛟 FLBK</title>\``
