// Command jeff serves a small control page for one Ecovacs robot.
//
// It runs bridge.js (Node, using the ecovacs-deebot library) as a child process, streams the
// bridge's JSON event lines to browsers via Server-Sent Events and forwards
// commands posted by the page to the bridge's stdin.
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"
)

//go:embed static
var staticFiles embed.FS

const bridgeRestartDelay = 30 * time.Second

// command is the request body of POST /api/command, forwarded to the bridge as-is.
type command struct {
	Command string            `json:"command"`
	Args    []json.RawMessage `json:"args"`
}

// event is one line written by the bridge; Data is passed through untouched.
type event struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// main parses the flags, starts the bridge and serves the page and API.
func main() {
	addr := flag.String("addr", ":3000", "HTTP listen address")
	script := flag.String("bridge", "bridge/bridge.js", "path to the Node bridge script")
	flag.Parse()

	h := newHub()
	b := &bridge{script: *script, hub: h}
	go b.run()

	static, _ := fs.Sub(staticFiles, "static")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /api/events", h.serveEvents)
	mux.HandleFunc("POST /api/command", b.serveCommand)

	log.Printf("listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// hub keeps the latest line per event and fans new lines out to SSE clients.
type hub struct {
	mu      sync.Mutex
	latest  map[string][]byte
	order   []string
	clients map[chan []byte]struct{}
}

// newHub returns an empty hub.
func newHub() *hub {
	return &hub{latest: map[string][]byte{}, clients: map[chan []byte]struct{}{}}
}

// publish stores line as the latest value of name and sends it to all clients.
func (h *hub) publish(name string, line []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, seen := h.latest[name]; !seen {
		h.order = append(h.order, name)
	}
	h.latest[name] = line
	for client := range h.clients {
		select {
		case client <- line:
		default: // slow client: drop the line rather than block the bridge
		}
	}
}

// subscribe registers a client and returns the current snapshot to replay first.
func (h *hub) subscribe(client chan []byte) [][]byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[client] = struct{}{}
	snapshot := make([][]byte, 0, len(h.order))
	for _, name := range h.order {
		snapshot = append(snapshot, h.latest[name])
	}
	return snapshot
}

// unsubscribe removes a client.
func (h *hub) unsubscribe(client chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, client)
}

// serveEvents streams the snapshot and then every new event line as SSE.
func (h *hub) serveEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	client := make(chan []byte, 64)
	defer h.unsubscribe(client)
	for _, line := range h.subscribe(client) {
		fmt.Fprintf(w, "data: %s\n\n", line)
	}
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case line := <-client:
			fmt.Fprintf(w, "data: %s\n\n", line)
			flusher.Flush()
		}
	}
}

// bridge owns the Node child process and its stdin.
type bridge struct {
	script string
	hub    *hub

	mu    sync.Mutex
	stdin io.WriteCloser
}

// run keeps the bridge process alive, restarting it after it exits.
func (b *bridge) run() {
	for {
		err := b.runOnce()
		log.Printf("bridge exited (%v), restarting in %s", err, bridgeRestartDelay)
		b.hub.publish("Status", []byte(`{"event":"Status","data":"offline"}`))
		time.Sleep(bridgeRestartDelay)
	}
}

// runOnce starts the bridge and publishes its stdout lines until it exits.
func (b *bridge) runOnce() error {
	cmd := exec.Command("node", b.script)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	b.setStdin(stdin)
	defer b.setStdin(nil)

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		var ev event
		if err := json.Unmarshal(line, &ev); err != nil || ev.Event == "" {
			log.Printf("bridge: ignoring non-event line: %s", line)
			continue
		}
		b.hub.publish(ev.Event, line)
	}
	return cmd.Wait()
}

// setStdin swaps the stdin of the current bridge process.
func (b *bridge) setStdin(stdin io.WriteCloser) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stdin = stdin
}

// send writes one command line to the bridge.
func (b *bridge) send(c command) error {
	line, err := json.Marshal(c)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stdin == nil {
		return errors.New("robot bridge is not running")
	}
	_, err = b.stdin.Write(append(line, '\n'))
	return err
}

// serveCommand validates a posted command and forwards it to the bridge.
func (b *bridge) serveCommand(w http.ResponseWriter, r *http.Request) {
	var c command
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&c); err != nil || c.Command == "" {
		http.Error(w, "expected JSON body {\"command\": \"...\", \"args\": [...]}", http.StatusBadRequest)
		return
	}
	if err := b.send(c); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
