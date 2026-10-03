/**
 * @ompiui/relay 的运行时公共面：线协议常量/帧编解码 + 背压写流。
 * 服务端隧道客户端（packages/server）从这里导入，保证两侧协议单一来源。
 * CLI（cli.ts）与配置加载（config.ts）只在直接运行 omp-relay 时使用。
 */

export * from "./protocol.ts"
export { BodySink, type BodySource } from "./sink.ts"
export { startRelay, type RunningRelay, type StartRelayOptions } from "./relay.ts"
