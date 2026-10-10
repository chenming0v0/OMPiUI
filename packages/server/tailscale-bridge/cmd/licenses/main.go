package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	output := flag.String("out", "", "license notice output path")
	flag.Parse()
	data, err := exec.Command("go", "list", "-deps", "-json", ".", "./mobile").Output()
	if err != nil {
		log.Fatal(err)
	}
	type module struct {
		Path, Version, Dir string
		Main               bool
	}
	modules := map[string]module{}
	decoder := json.NewDecoder(bytes.NewReader(data))
	for {
		var entry struct{ Module *module }
		if err := decoder.Decode(&entry); err == io.EOF {
			break
		} else if err != nil {
			log.Fatal(err)
		}
		if entry.Module != nil && !entry.Module.Main {
			modules[entry.Module.Path] = *entry.Module
		}
	}
	keys := make([]string, 0, len(modules))
	for key := range modules {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var notice strings.Builder
	for _, key := range keys {
		m := modules[key]
		fmt.Fprintf(&notice, "%s %s\n", m.Path, m.Version)
		entries, err := os.ReadDir(m.Dir)
		if err != nil {
			log.Fatal(err)
		}
		found := false
		for _, entry := range entries {
			name := strings.ToUpper(entry.Name())
			if entry.IsDir() || !(strings.HasPrefix(name, "LICENSE") || strings.HasPrefix(name, "COPYING") || strings.HasPrefix(name, "NOTICE")) {
				continue
			}
			text, err := os.ReadFile(filepath.Join(m.Dir, entry.Name()))
			if err != nil {
				log.Fatal(err)
			}
			fmt.Fprintf(&notice, "%s\n%s\n", entry.Name(), text)
			found = true
		}
		if !found {
			fmt.Fprintf(&notice, "License information: consult %s at version %s.\n", m.Path, m.Version)
		}
		fmt.Fprintln(&notice, strings.Repeat("=", 72))
	}
	if err := os.WriteFile(*output, []byte(notice.String()), 0o644); err != nil {
		log.Fatal(err)
	}
}
