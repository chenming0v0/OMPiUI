//! 仅计量 WebView 尚未确认消费的消息。

use std::collections::VecDeque;

// 对齐服务端合法的出站事件大小，而不是较小的客户端帧上限。
pub(super) const MAX_INBOUND_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_INBOUND_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_INBOUND_MESSAGES: usize = 1024;

#[derive(Default)]
pub(super) struct InboundLedger {
    pending: VecDeque<(u64, usize)>,
    bytes: usize,
    last_sequence: u64,
    acknowledged: u64,
}

impl InboundLedger {
    // 读取前先为下一条完整消息预留容量，避免阻塞的读取端额外持有
    // 一条未计量的 4 MiB 消息。
    pub(super) fn can_receive(&self) -> bool {
        self.pending.len() < MAX_INBOUND_MESSAGES
            && self.bytes <= MAX_INBOUND_BYTES - MAX_INBOUND_MESSAGE_BYTES
    }

    pub(super) fn record(&mut self, bytes: usize) -> Result<u64, &'static str> {
        if bytes > MAX_INBOUND_MESSAGE_BYTES {
            return Err("WebSocket bridge message exceeds 4 MiB");
        }
        if self.pending.len() >= MAX_INBOUND_MESSAGES || self.bytes + bytes > MAX_INBOUND_BYTES {
            return Err("WebSocket bridge unconsumed message budget exceeded");
        }
        let sequence = self
            .last_sequence
            .checked_add(1)
            .ok_or("WebSocket bridge message sequence exhausted")?;
        self.pending.push_back((sequence, bytes));
        self.bytes += bytes;
        self.last_sequence = sequence;
        Ok(sequence)
    }

    pub(super) fn acknowledge(&mut self, sequence: u64) -> Result<(), &'static str> {
        if sequence > self.last_sequence {
            return Err("WebSocket bridge acknowledgement is ahead of delivery");
        }
        if sequence <= self.acknowledged {
            return Ok(());
        }
        while self.pending.front().is_some_and(|(pending, _)| *pending <= sequence) {
            if let Some((_, bytes)) = self.pending.pop_front() {
                self.bytes -= bytes;
            }
        }
        self.acknowledged = sequence;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consumed_stream_can_continue_far_beyond_the_backlog_limit() {
        let mut ledger = InboundLedger::default();
        for _ in 0..512 {
            assert!(ledger.can_receive());
            let sequence = ledger.record(128 * 1024).unwrap();
            ledger.acknowledge(sequence).unwrap();
        }
        assert_eq!(ledger.bytes, 0);
        assert_eq!(ledger.pending.len(), 0);
    }

    #[test]
    fn unconsumed_bytes_block_until_the_correct_prefix_is_acknowledged() {
        let mut ledger = InboundLedger::default();
        let first = ledger.record(2 * 1024 * 1024).unwrap();
        let second = ledger.record(2 * 1024 * 1024).unwrap();
        let third = ledger.record(MAX_INBOUND_MESSAGE_BYTES).unwrap();
        assert!(!ledger.can_receive());
        assert!(ledger.record(1).is_err());
        assert!(ledger.acknowledge(third + 1).is_err());
        assert_eq!(ledger.bytes, MAX_INBOUND_BYTES);
        ledger.acknowledge(first).unwrap();
        assert!(!ledger.can_receive());
        ledger.acknowledge(first).unwrap();
        assert_eq!(ledger.bytes, 6 * 1024 * 1024);
        ledger.acknowledge(second).unwrap();
        assert!(ledger.can_receive());
        assert_eq!(ledger.bytes, MAX_INBOUND_MESSAGE_BYTES);
    }

    #[test]
    fn empty_messages_also_require_consumption_acknowledgements() {
        let mut ledger = InboundLedger::default();
        let mut last = 0;
        for _ in 0..MAX_INBOUND_MESSAGES {
            last = ledger.record(0).unwrap();
        }
        assert!(!ledger.can_receive());
        assert!(ledger.record(0).is_err());
        ledger.acknowledge(last).unwrap();
        assert!(ledger.can_receive());
        assert_eq!(ledger.record(0).unwrap(), last + 1);
    }

    #[test]
    fn legal_server_events_above_128_kib_are_not_rejected() {
        let mut ledger = InboundLedger::default();
        for bytes in [128 * 1024, 128 * 1024 + 1, MAX_INBOUND_MESSAGE_BYTES] {
            let sequence = ledger.record(bytes).unwrap();
            ledger.acknowledge(sequence).unwrap();
        }
        assert_eq!(
            ledger.record(MAX_INBOUND_MESSAGE_BYTES + 1),
            Err("WebSocket bridge message exceeds 4 MiB")
        );
        assert_eq!(ledger.bytes, 0);
    }
}
