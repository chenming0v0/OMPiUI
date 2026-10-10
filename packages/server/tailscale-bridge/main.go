package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/chenming0v0/ompiui-tailscale-bridge/internal/gateway"
	"tailscale.com/tsnet"
)

type config struct {
	stateDir    string
	hostname    string
	controlAddr string
	listenAddr  string
	upstream    string
}

type readyMessage struct {
	Event       string `json:"event"`
	ControlAddr string `json:"controlAddr"`
}

func main() {
	cfg := config{}
	flag.StringVar(&cfg.stateDir, "state-dir", "", "directory for the embedded Tailscale state")
	flag.StringVar(&cfg.hostname, "hostname", "ompiui", "Tailscale hostname")
	flag.StringVar(&cfg.controlAddr, "control-listen", "127.0.0.1:0", "local control HTTP address")
	flag.StringVar(&cfg.listenAddr, "listen", "", "tailnet listener address, for example :8787")
	flag.StringVar(&cfg.upstream, "upstream", "", "local OMPiUI HTTP origin to reverse proxy")
	flag.Parse()

	if cfg.stateDir == "" {
		log.Fatal("--state-dir is required")
	}
	if err := os.MkdirAll(cfg.stateDir, 0o700); err != nil {
		log.Fatal(err)
	}

	userLogf := func(string, ...any) {}
	ts := &tsnet.Server{
		Dir:      cfg.stateDir,
		Hostname: cfg.hostname,
		UserLogf: userLogf,
		Logf:     func(string, ...any) {},
	}
	if err := ts.Start(); err != nil {
		log.Fatal(err)
	}

	var proxyListener net.Listener
	if cfg.listenAddr != "" {
		if cfg.upstream == "" {
			log.Fatal("--upstream is required when --listen is set")
		}
		target, err := gateway.LoopbackURL(cfg.upstream)
		if err != nil {
			log.Fatalf("invalid upstream: %v", err)
		}
		proxyListener, err = ts.Listen("tcp", cfg.listenAddr)
		if err != nil {
			log.Fatalf("tailnet listen: %v", err)
		}
		proxy := gateway.Proxy(target, (&net.Dialer{}).DialContext, true)
		go func() {
			if err := http.Serve(proxyListener, proxy); err != nil && !strings.Contains(err.Error(), "use of closed network connection") {
				log.Printf("tailnet proxy stopped: %v", err)
			}
		}()
	}

	controlListener, err := net.Listen("tcp", cfg.controlAddr)
	if err != nil {
		log.Fatalf("control listen: %v", err)
	}
	token := os.Getenv("OMPIUI_BRIDGE_TOKEN")
	if token == "" {
		log.Fatal("control token is required")
	}
	stop := make(chan struct{})
	var once sync.Once
	shutdown := func() { once.Do(func() { close(stop) }) }
	handler := controlHandler(ts, shutdown)
	controlServer := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			handler.ServeHTTP(w, r)
		}),
	}
	go func() {
		if err := controlServer.Serve(controlListener); err != nil && err != http.ErrServerClosed {
			log.Printf("control server stopped: %v", err)
		}
	}()

	ready, _ := json.Marshal(readyMessage{
		Event:       "ready",
		ControlAddr: "http://" + controlListener.Addr().String(),
	})
	fmt.Println(string(ready))

	go func() { io.Copy(io.Discard, bufio.NewReader(os.Stdin)); shutdown() }()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() { <-signals; shutdown() }()
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = controlServer.Shutdown(ctx)
	if proxyListener != nil {
		_ = proxyListener.Close()
	}
	_ = ts.Close()
}

func controlHandler(ts *tsnet.Server, shutdown func()) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		client, err := ts.LocalClient()
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		status, err := client.StatusWithoutPeers(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, status)
	})
	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) {
		client, err := ts.LocalClient()
		if err == nil {
			err = client.StartLoginInteractive(r.Context())
		}
		if err != nil {
			http.Error(w, "login unavailable", 503)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /shutdown", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		go shutdown()
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
