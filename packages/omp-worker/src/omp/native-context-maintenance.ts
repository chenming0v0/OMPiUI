// 使用官方设置解析器，包含模型级覆盖；只读状态，不重复执行原生每回合清理。
export const nativeContextMaintenanceImports = String.raw`
import { createHash as contextHash } from "node:crypto";
import { resolveModelCompactionSettings as contextSettings, describeModelCompactionPoint as contextPoint } from "@oh-my-pi/pi-coding-agent/session/model-compaction-threshold";
`;

export const nativeContextMaintenanceSource = String.raw`
  function contextMaintenance(session, previousPruningRevision) {
    const settings = contextSettings(session.settings, session.model);
    const point = session.model ? contextPoint(session.settings, session.model) : null;
    // 原生清理不改变 ID，get_entries(since) 无法发现旧条目的替换。
    // 仅传已清理的短结果；内容未变化时只传摘要，避免重复下载历史。
    const entries = session.sessionManager.getBranchView().filter(entry =>
      entry.type === "message" && entry.message.role === "toolResult" &&
      typeof entry.message.prunedAt === "number");
    const hash = contextHash("sha256");
    for (const entry of entries) hash.update(JSON.stringify([entry.id, entry.message.prunedAt, entry.message.content]));
    const pruningRevision = hash.digest("hex");
    return {
      contextMaintenance: {
        autoEnabled: session.autoCompactionEnabled,
        midTurnEnabled: settings.midTurnEnabled,
        asyncEnabled: settings.asyncEnabled,
        supersedeReads: settings.supersedeReads,
        dropUseless: settings.dropUseless,
        idleEnabled: settings.idleEnabled,
        idleSupported: false,
        thresholdTokens: session.autoCompactionEnabled ? point?.tokens ?? null : null,
        thresholdSource: point?.source ?? null,
        contextWindow: session.model?.contextWindow ?? null,
        speculation: session.compactionSpeculation,
        prunedResults: entries.length,
        pruningRevision,
      },
      ...(previousPruningRevision === pruningRevision ? {} : { prunedEntries: entries }),
    };
  }
`;
