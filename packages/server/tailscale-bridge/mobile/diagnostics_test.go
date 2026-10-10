//go:build !android

package mobile

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiagnosticsPreservesPreviousCrashAndCapturesNewErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "native-stderr.log")
	if err := os.WriteFile(path, []byte("previous crash stack\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	writer := log.Writer()
	t.Cleanup(func() {
		log.SetOutput(writer)
		if diagnosticsFile != nil {
			diagnosticsFile.Close()
			diagnosticsFile = nil
		}
	})
	if err := PrepareDiagnostics(dir); err != nil {
		t.Fatal(err)
	}
	if err := PrepareDiagnostics(dir); err != nil {
		t.Fatal(err)
	}
	log.Print("current failure stack")
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "previous crash stack") ||
		strings.Count(string(content), "current failure stack") != 1 {
		t.Fatalf("diagnostics truncated prior crash or duplicated output: %s", content)
	}
}
