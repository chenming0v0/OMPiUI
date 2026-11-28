package outbound

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestOrigin(t *testing.T) {
	for input, want := range map[string]string{
		"http://100.64.0.1:8787":           "http://100.64.0.1:8787",
		"https://host.example.ts.net":      "https://host.example.ts.net",
		"http://[fd7a:115c:a1e0::1]:8787/": "http://[fd7a:115c:a1e0::1]:8787",
	} {
		target, err := Origin(input)
		if err != nil || target.String() != want {
			t.Errorf("%s: %v %v", input, target, err)
		}
	}
	for _, input := range []string{"http://192.168.1.1", "http://100.128.1.1", "http://localhost", "http://127.0.0.1:8787", "http://public.example", "http://user:pass@host.ts.net", "ftp://host.ts.net", "http://host.ts.net/api", "http://host.ts.net?token=private"} {
		if _, err := Origin(input); err == nil {
			t.Errorf("unexpected origin accepted: %s", input)
		}
	}
}

func TestRoutesForwardThroughTheNodeDialerAndCloseTheirLoopbackPorts(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, r.Host+r.URL.Path)
	}))
	defer upstream.Close()
	dialed := make(chan string, 4)
	dial := func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed <- address
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	target, err := url.Parse("http://100.64.0.2:8787")
	if err != nil {
		t.Fatal(err)
	}
	var routes Routes
	local, err := routes.Open(target, dial)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(local)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" {
		t.Fatalf("route is not a loopback origin: %s %v", local, err)
	}
	if again, err := routes.Open(target, dial); err != nil || again != local {
		t.Fatalf("same origin opened a second route: %s %v", again, err)
	}
	response, err := http.Get(local + "/api/v1/host/health")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != "100.64.0.2:8787/api/v1/host/health" {
		t.Fatalf("request was not forwarded to the Tailnet origin: %q %v", body, err)
	}
	if address := <-dialed; address != "100.64.0.2:8787" {
		t.Fatalf("route did not dial the Tailnet address: %s", address)
	}

	routes.Close()
	if conn, err := net.Dial("tcp", parsed.Host); err == nil {
		conn.Close()
		t.Fatal("loopback port stayed open after Close")
	}
	reopened, err := routes.Open(target, dial)
	if err != nil || reopened == "" {
		t.Fatalf("route could not be reopened after Close: %v", err)
	}
	routes.Close()
}
