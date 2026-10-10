package mobile

import (
	"os"
	"runtime/debug"

	"golang.org/x/sys/unix"
)

func attachDiagnosticOutput(file *os.File) error {
	// Go 后台协程的致命异常直接写 stderr，不能只依赖标准 log 的输出。
	if err := unix.Dup3(int(file.Fd()), int(os.Stderr.Fd()), 0); err != nil {
		return err
	}
	debug.SetTraceback("all")
	return nil
}
