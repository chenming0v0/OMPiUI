package mobile

import (
	"fmt"
	"log"
	"runtime/debug"
)

// 原生调用中的 Go panic 不能交给 Kotlin catch，必须在跨越 JNI 前转成错误。
func recoverNativeError(operation string, err *error) {
	if failure := recover(); failure != nil {
		log.Printf("Tailscale %s panic: %v\n%s", operation, failure, debug.Stack())
		*err = fmt.Errorf("Tailscale %s failed: %v", operation, failure)
	}
}
