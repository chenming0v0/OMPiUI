//go:build !android

package mobile

import "os"

func attachDiagnosticOutput(file *os.File) error { return nil }
