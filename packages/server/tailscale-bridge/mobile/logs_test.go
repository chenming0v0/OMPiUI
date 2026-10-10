package mobile

import (
	"os"
	"path/filepath"
	"testing"

	"tailscale.com/logpolicy"
)

func TestLogsDirectoryUsesPrivateStorageWithoutHome(t *testing.T) {
	t.Setenv("TS_LOGS_DIR", "")
	t.Setenv("HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing-system-temp"))
	stateDir := filepath.Join(t.TempDir(), "tailscale")
	if err := prepareLogsDirectory(stateDir); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(stateDir, "logs")
	got := logpolicy.LogsDir(func(string, ...any) {})
	if got != want {
		t.Fatalf("Tailscale logpolicy used %q instead of private directory %q", got, want)
	}
	path := filepath.Join(got, "log-state-test")
	if err := os.WriteFile(path, []byte("state"), 0o600); err != nil {
		t.Fatalf("private logs directory is not writable: %v", err)
	}
	if err := prepareLogsDirectory(stateDir); err != nil {
		t.Fatalf("startup retry failed: %v", err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "state" {
		t.Fatalf("startup retry lost log state: %q, %v", data, err)
	}
}

func TestLogsDirectoryFailureReturnsErrorBeforeCoreStarts(t *testing.T) {
	t.Setenv("TS_LOGS_DIR", "")
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "logs"), []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := Start(stateDir, "ompiui-test")
	if err == nil {
		t.Fatal("startup accepted an unavailable log directory")
	}
	if os.Getenv("TS_LOGS_DIR") != "" || node != nil {
		t.Fatal("failed directory preparation changed runtime state or started the core")
	}
}
