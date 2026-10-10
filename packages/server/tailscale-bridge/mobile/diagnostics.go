package mobile

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
)

var diagnosticsLock sync.Mutex
var diagnosticsFile *os.File

// PrepareDiagnostics 在启动核心前保留日志，供手机重开应用后导出。
func PrepareDiagnostics(stateDir string) error {
	diagnosticsLock.Lock()
	defer diagnosticsLock.Unlock()
	if diagnosticsFile != nil {
		return nil
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(stateDir, "native-stderr.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 1024*1024 {
		if err := os.Rename(path, path+".previous"); err != nil {
			return err
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if err := attachDiagnosticOutput(file); err != nil {
		file.Close()
		return err
	}
	log.SetOutput(io.MultiWriter(log.Writer(), file))
	diagnosticsFile = file
	return nil
}
