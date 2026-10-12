import { stripVTControlCharacters } from "node:util";
import type { ConsoleLog, Tone } from "./types.ts";

export function safeText(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    "",
  );
}

export function redact(
  value: string,
  secrets: Array<string | undefined> = [],
): string {
  let text = safeText(value)
    .replace(/([?&](?:token|key|pair|code)=)[^&\s]+/gi, "$1[hidden]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, "$1[hidden]");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[hidden]");
  }
  return text;
}

export class LogBuffer {
  private entries: ConsoleLog[] = [];

  constructor(
    private readonly secrets: () => Array<string | undefined> = () => [],
  ) {}

  append(text: string, tone: Tone = "neutral"): void {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      this.entries.push({
        time: Date.now(),
        text: redact(line, this.secrets()).slice(0, 2_000),
        tone,
      });
    }
    this.entries = this.entries.slice(-300);
  }

  read(): ConsoleLog[] {
    return this.entries.map((entry) => ({
      ...entry,
      text: redact(entry.text, this.secrets()),
    }));
  }
}
