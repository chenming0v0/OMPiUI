package mobile

import "testing"

func TestTailnetOrigins(t *testing.T) {
	for _, input := range []string{"http://100.64.0.1:8787", "https://host.example.ts.net", "http://[fd7a:115c:a1e0::1]:8787/"} {
		if _, err := tailnetURL(input); err != nil {
			t.Errorf("%s: %v", input, err)
		}
	}
	for _, input := range []string{"http://192.168.1.1", "http://100.128.1.1", "http://localhost", "http://public.example", "http://user:pass@host.ts.net", "ftp://host.ts.net", "http://host.ts.net/api", "http://host.ts.net?token=private"} {
		if _, err := tailnetURL(input); err == nil {
			t.Errorf("unexpected origin accepted: %s", input)
		}
	}
}
