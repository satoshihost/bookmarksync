package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

const (
	maxSyncSize = 2 * 1024 * 1024 // 2MB
	version     = "1.0.1"
	port        = ":8080"
)

var (
	dataDir      = "./data"
	rateLimits   = make(map[string]time.Time)
	rateLimitsMu sync.Mutex
	storeMu      sync.Mutex
)

func main() {
	// Create data directory
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	// Setup router
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sync", withLogging(withCORS(handleCreate)))
	mux.HandleFunc("GET /sync/{id}", withLogging(withCORS(handleGet)))
	mux.HandleFunc("PUT /sync/{id}", withLogging(withCORS(handlePut)))
	mux.HandleFunc("DELETE /sync/{id}", withLogging(withCORS(handleDelete)))
	mux.HandleFunc("GET /sync/{id}/info", withLogging(withCORS(handleInfo)))
	mux.HandleFunc("GET /status", withLogging(withCORS(handleStatus)))
	mux.HandleFunc("OPTIONS /sync", withLogging(withCORS(handleOptions)))
	mux.HandleFunc("OPTIONS /sync/{id}", withLogging(withCORS(handleOptions)))
	mux.HandleFunc("OPTIONS /sync/{id}/info", withLogging(withCORS(handleOptions)))
	mux.HandleFunc("OPTIONS /status", withLogging(withCORS(handleOptions)))

	// Setup server
	server := &http.Server{
		Addr:         port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigint := make(chan os.Signal, 1)
		signal.Notify(sigint, os.Interrupt, syscall.SIGTERM)
		<-sigint
		log.Println("Shutting down server...")
		if err := server.Close(); err != nil {
			log.Printf("Error during shutdown: %v", err)
		}
	}()

	log.Printf("Full Browser Sync server v%s starting on %s", version, port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
	log.Println("Server stopped")
}

// Middleware: CORS headers for browser extension
func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Expected-Rev")
		w.Header().Set("Access-Control-Expose-Headers", "X-Sync-Rev, Last-Modified")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Max-Age", "3600")
		next(w, r)
	}
}

// Middleware: Request logging
func withLogging(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		log.Printf("%s %s from %s", r.Method, r.URL.Path, r.RemoteAddr)
		next(w, r)
		log.Printf("%s %s completed in %v", r.Method, r.URL.Path, time.Since(start))
	}
}

// Helper: Get blob file path
func blobPath(id string) string {
	return filepath.Join(dataDir, id+".blob")
}

// Helper: Get hash sidecar file path (legacy; removed on DELETE)
func hashPath(id string) string {
	return filepath.Join(dataDir, id+".hash")
}

// Helper: Get revision sidecar file path
func revPath(id string) string {
	return filepath.Join(dataDir, id+".rev")
}

// readRev returns the current revision for a sync ID.
// Missing or unreadable sidecars are revision 0 (including blobs from before
// this counter existed).
func readRev(id string) int {
	b, err := os.ReadFile(revPath(id))
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func writeRev(id string, rev int) error {
	return os.WriteFile(revPath(id), []byte(strconv.Itoa(rev)), 0644)
}

// Helper: Validate Sync ID (UUID v4 or 3-64 character alphanumeric string with hyphens/underscores)
func isValidSyncID(s string) bool {
	if len(s) < 3 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

// Helper: Send JSON response
func sendJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error encoding JSON: %v", err)
	}
}

// OPTIONS handler for CORS preflight
func handleOptions(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// POST /sync - Create new sync ID
func handleCreate(w http.ResponseWriter, r *http.Request) {
	id := uuid.New().String()
	sendJSON(w, map[string]interface{}{
		"id":  id,
		"rev": 0,
	})
}

// GET /sync/{id} - Download encrypted blob
func handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidSyncID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	storeMu.Lock()
	data, err := os.ReadFile(blobPath(id))
	rev := readRev(id)
	storeMu.Unlock()
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", http.StatusNotFound)
		} else {
			http.Error(w, "storage error", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Sync-Rev", strconv.Itoa(rev))
	if _, err := w.Write(data); err != nil {
		log.Printf("Error sending blob: %v", err)
	}
}

// PUT /sync/{id} - Upload encrypted blob
func handlePut(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidSyncID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	expectedHeader := strings.TrimSpace(r.Header.Get("X-Expected-Rev"))
	var expectedRev int
	checkExpected := false
	if expectedHeader != "" {
		n, err := strconv.Atoi(expectedHeader)
		if err != nil || n < 0 {
			http.Error(w, "invalid X-Expected-Rev", http.StatusBadRequest)
			return
		}
		expectedRev = n
		checkExpected = true
	}

	// Limit body size before taking the store lock
	r.Body = http.MaxBytesReader(w, r.Body, maxSyncSize)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "body too large or read error", http.StatusBadRequest)
		return
	}

	storeMu.Lock()
	defer storeMu.Unlock()

	current := readRev(id)
	if checkExpected && expectedRev != current {
		w.WriteHeader(http.StatusConflict)
		sendJSON(w, map[string]interface{}{
			"error": "revision mismatch",
			"rev":   current,
		})
		return
	}

	// Rate limiting: max 1 PUT per sync ID per 5 seconds
	rateLimitsMu.Lock()
	if last, ok := rateLimits[id]; ok && time.Since(last) < 5*time.Second {
		rateLimitsMu.Unlock()
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	rateLimits[id] = time.Now()
	rateLimitsMu.Unlock()

	if err := os.WriteFile(blobPath(id), data, 0644); err != nil {
		log.Printf("Error writing blob: %v", err)
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	newRev := current + 1
	if err := writeRev(id, newRev); err != nil {
		log.Printf("Error writing revision sidecar: %v", err)
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	sendJSON(w, map[string]interface{}{
		"rev": newRev,
	})
}

// DELETE /sync/{id} - Delete sync data
func handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidSyncID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	storeMu.Lock()
	defer storeMu.Unlock()

	if err := os.Remove(blobPath(id)); err != nil && !os.IsNotExist(err) {
		log.Printf("Error deleting blob: %v", err)
	}
	if err := os.Remove(hashPath(id)); err != nil && !os.IsNotExist(err) {
		log.Printf("Error deleting hash sidecar: %v", err)
	}
	if err := os.Remove(revPath(id)); err != nil && !os.IsNotExist(err) {
		log.Printf("Error deleting revision sidecar: %v", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /sync/{id}/info - Get last modified time without downloading blob
func handleInfo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidSyncID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	storeMu.Lock()
	defer storeMu.Unlock()

	// Confirm the blob exists
	if _, err := os.Stat(blobPath(id)); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	sendJSON(w, map[string]interface{}{
		"rev": readRev(id),
	})
}

// GET /status - Server health check
func handleStatus(w http.ResponseWriter, r *http.Request) {
	sendJSON(w, map[string]interface{}{
		"status":      "online",
		"version":     version,
		"maxSyncSize": maxSyncSize,
	})
}
