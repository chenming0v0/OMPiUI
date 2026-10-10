package mobile

import (
	"os"
	"path/filepath"
)

// 节点 Dir 不控制 logpolicy 的路径，Android 必须在启动前另行指定私有日志目录。
func prepareLogsDirectory(stateDir string) error {
	dir, err := filepath.Abs(filepath.Join(stateDir, "logs"))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.Setenv("TS_LOGS_DIR", dir)
}
