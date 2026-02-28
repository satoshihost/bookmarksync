package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
)

const (
	maxSyncSize = 2 * 1024 * 1024 // 2MB
	dataDir     = "./data"
	version     = "1.0.0"
	port        = ":8080"
)

var (
	rateLimits   = make(map[string]time.Time)
	rateLimitsMu sync.Mutex
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

	log.Printf("BookmarkSync server v%s starting on %s", version, port)
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
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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

// Helper: Validate UUID
func isValidUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
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
		"id":           id,
		"lastModified": nil,
	})
}

// GET /sync/{id} - Download encrypted blob
func handleGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidUUID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	path := blobPath(id)
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Last-Modified", stat.ModTime().UTC().Format(http.TimeFormat))
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("Error sending blob: %v", err)
	}
}

// PUT /sync/{id} - Upload encrypted blob
func handlePut(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidUUID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	// Rate limiting: max 1 PUT per sync ID per 30 seconds
	rateLimitsMu.Lock()
	if last, ok := rateLimits[id]; ok && time.Since(last) < 30*time.Second {
		rateLimitsMu.Unlock()
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	rateLimits[id] = time.Now()
	rateLimitsMu.Unlock()

	// Limit body size
	r.Body = http.MaxBytesReader(w, r.Body, maxSyncSize)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "body too large or read error", http.StatusBadRequest)
		return
	}

	// Write to file
	if err := os.WriteFile(blobPath(id), data, 0644); err != nil {
		log.Printf("Error writing blob: %v", err)
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	sendJSON(w, map[string]string{
		"lastModified": time.Now().UTC().Format(time.RFC3339),
	})
}

// DELETE /sync/{id} - Delete sync data
func handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidUUID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	if err := os.Remove(blobPath(id)); err != nil && !os.IsNotExist(err) {
		log.Printf("Error deleting blob: %v", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /sync/{id}/info - Get last modified time without downloading blob
func handleInfo(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidUUID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	stat, err := os.Stat(blobPath(id))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	sendJSON(w, map[string]string{
		"lastModified": stat.ModTime().UTC().Format(time.RFC3339),
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
