import { randomUUID } from "node:crypto";
import type {
  BranchCheckpoint,
  BranchSyncRequest,
  EntriesPage,
  JsonObject,
  SessionHead,
} from "@ompiui/protocol";
import {
  beforeEntryCursor,
  entriesPageFromEntries,
  projectEntryAttachments,
} from "./pagination.js";

type PageOptions = BranchSyncRequest & {
  cursor?: string;
  limit: number;
  maxBytes: number;
  checkpoint?: BranchCheckpoint;
};

/** OMP 已落盘条目只追加；重新播种时对象会整体替换，自动退回完整分页。 */
export class BranchPageReader<T extends { id: string }> {
  // 少量快照支持多个页面同时读取；只保留条目引用，不复制正文。
  private readonly snapshots = new Map<string, readonly T[]>();

  clear(): void {
    this.snapshots.clear();
  }

  read(
    head: SessionHead,
    entries: readonly T[],
    options: PageOptions,
    serialize: (entry: T) => JsonObject,
  ): EntriesPage {
    options = {
      ...options,
      limit: Math.min(options.limit, 200),
      maxBytes: Math.min(options.maxBytes, 4 * 1024 * 1024),
    };
    if (options.beforeId && !options.syncCursor && !options.cursor) {
      return entriesPageFromEntries(
        head,
        entries,
        { ...options, cursor: beforeEntryCursor(head, options.beforeId) },
        serialize,
      );
    }
    if (options.cursor)
      return entriesPageFromEntries(head, entries, options, serialize);

    const previous = options.syncCursor
      ? this.snapshots.get(options.syncCursor)
      : undefined;
    const extendsPrevious =
      previous &&
      previous.length <= entries.length &&
      previous.every((entry, index) => entry === entries[index]);
    const before = options.beforeId
      ? entries.findIndex((entry) => entry.id === options.beforeId)
      : 0;
    const canAppend =
      extendsPrevious &&
      before >= 0 &&
      (previous.length === 0 ||
        (Boolean(options.beforeId) && before < previous.length));

    let syncCursor = [...this.snapshots].find(
      ([, snapshot]) =>
        snapshot.length === entries.length &&
        snapshot.every((entry, index) => entry === entries[index]),
    )?.[0];
    syncCursor ??= randomUUID();

    if (canAppend && entries.length - previous.length <= options.limit) {
      const page: EntriesPage = {
        head,
        items: entries
          .slice(previous.length)
          .map((entry) => projectEntryAttachments(serialize(entry), head)),
        checkpoint: options.checkpoint,
        beforeCursor:
          before > 0 ? beforeEntryCursor(head, entries[before]!.id) : undefined,
        hasMore: before > 0,
        syncCursor,
        deltaFrom: options.syncCursor,
      };
      if (Buffer.byteLength(JSON.stringify(page), "utf8") <= options.maxBytes) {
        this.remember(syncCursor, entries);
        return page;
      }
    }

    // 将同步标识计入字节上限；超限时沿用原分页的限制和错误语义。
    const overhead =
      Buffer.byteLength(JSON.stringify({ syncCursor }), "utf8") - 1;
    const page = entriesPageFromEntries(
      head,
      entries,
      { ...options, maxBytes: options.maxBytes - overhead },
      serialize,
    );
    this.remember(syncCursor, entries);
    return { ...page, syncCursor };
  }

  private remember(cursor: string, entries: readonly T[]): void {
    this.snapshots.delete(cursor);
    this.snapshots.set(cursor, [...entries]);
    if (this.snapshots.size > 4)
      this.snapshots.delete(this.snapshots.keys().next().value!);
  }
}
