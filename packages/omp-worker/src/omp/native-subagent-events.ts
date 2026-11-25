/** 生成只读事件投影；正文交由 worker 的消息流计算增量，工具结果从原生历史读取。 */
export const nativeSubagentEventsSource = String.raw`
  function subagentDisplayEvent(event) {
    if (["message_start", "message_update", "message_end"].includes(event.type)) {
      const message = event.message;
      if (!message || !["assistant", "user"].includes(message.role)) return;
      const content = Array.isArray(message.content) ? message.content.flatMap(block => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "thinking") return [{ type: "thinking", thinking: block.thinking }];
        if (block.type === "toolCall") return [{ type: "toolCall", id: block.id, name: block.name, title: block.title }];
        return [];
      }) : message.content;
      return { type: event.type, messageId: event.messageId,
        message: { role: message.role, id: message.id, content, stopReason: message.stopReason } };
    }
    if (event.type === "irc_message") {
      return { type: event.type, message: { details: {
        from: event.message?.details?.from, message: event.message?.details?.message,
      } } };
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) {
      return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
        title: event.title, isError: event.isError };
    }
  }
`;
