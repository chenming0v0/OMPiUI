import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const audit = JSON.parse(
  readFileSync(
    new URL("../docs/network-issue-resolutions.json", import.meta.url),
    "utf8",
  ),
);
const commitIndex = process.argv.indexOf("--commit");
const commit = commitIndex >= 0 ? process.argv[commitIndex + 1] : undefined;
const apply = process.argv.includes("--apply");
const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const resolutions = new Map(
  audit.resolutions.map((item) => [item.number, item]),
);
const issues = JSON.parse(
  gh(
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title",
  ),
);
const missing = issues.filter((issue) => !resolutions.has(issue.number));
if (missing.length)
  throw new Error(
    `Unreviewed issues: ${missing.map((issue) => `#${issue.number}`).join(", ")}`,
  );
if (apply && !commit)
  throw new Error("--commit is required when applying resolutions");
const marker = `OMPiUI 网络修复批次 v${audit.version}`;
for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
  const item = resolutions.get(issue.number);
  console.log(`#${issue.number}: ${item.reason}`);
  if (!apply) continue;
  const comments = JSON.parse(
    gh("issue", "view", String(issue.number), "--json", "comments"),
  ).comments;
  if (!comments.some((comment) => comment.body.includes(marker))) {
    const body = [
      `### ${marker}`,
      "已完成源码复核。",
      item.summary,
      `相关源码：${item.files.map((file) => `\`${file}\``).join("、")}。`,
      `修复提交：\`${commit}\`（包含前序网络修复提交）。`,
      audit.verification,
      `本批使用协议 ${audit.protocol}，前端、服务端与 worker 需配套升级。`,
      item.reason === "not_planned"
        ? "报告的主要故障前提不成立，按复核结论关闭。"
        : "按本项修复结果关闭；发行产物另由发布流水线生成。",
    ].join("\n\n");
    gh("issue", "comment", String(issue.number), "--body", body);
  }
  gh(
    "issue",
    "close",
    String(issue.number),
    "--reason",
    item.reason === "not_planned" ? "not planned" : "completed",
  );
}
