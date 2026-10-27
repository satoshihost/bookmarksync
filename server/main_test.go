package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func testStore(t *testing.T) {
	t.Helper()
	oldDir := dataDir
	dataDir = t.TempDir()
	rateLimits = make(map[string]time.Time)
	t.Cleanup(func() { dataDir = oldDir })
}

func callHandler(handler http.HandlerFunc, method, id, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/sync/"+id, strings.NewReader(body))
	r.SetPathValue("id", id)
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	withCORS(handler)(w, r)
	return w
}

func TestSnapshotCacheAndRevision(t *testing.T) {
	testStore(t)
	id := "test-snapshot"
	put := callHandler(handlePut, "PUT", id, "encrypted-first", map[string]string{"X-Expected-Rev": "0"})
	if put.Code != http.StatusOK {
		t.Fatalf("PUT: %d %s", put.Code, put.Body.String())
	}
	get := callHandler(handleGet, "GET", id, "", nil)
	if get.Code != http.StatusOK || get.Body.String() != "encrypted-first" {
		t.Fatalf("GET: %d %s", get.Code, get.Body.String())
	}
	if get.Header().Get("X-Sync-Rev") != "1" {
		t.Fatalf("download must carry its revision; headers: %v", get.Header())
	}
	if !strings.Contains(get.Header().Get("Access-Control-Expose-Headers"), "X-Sync-Rev") {
		t.Fatal("revision header must be readable cross-origin")
	}
	for _, response := range []*httptest.ResponseRecorder{get, put, callHandler(handleInfo, "GET", id, "", nil)} {
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("response is cacheable: %v", response.Header())
		}
	}
	conflict := callHandler(handlePut, "PUT", id, "stale-overwrite", map[string]string{"X-Expected-Rev": "0"})
	if conflict.Code != http.StatusConflict {
		t.Fatalf("stale writer accepted: %d", conflict.Code)
	}
	get = callHandler(handleGet, "GET", id, "", nil)
	if get.Body.String() != "encrypted-first" || get.Header().Get("X-Sync-Rev") != "1" {
		t.Fatal("conflict changed the snapshot")
	}
}

func TestLegacySnapshot(t *testing.T) {
	testStore(t)
	id := "test-legacy"
	if err := os.WriteFile(blobPath(id), []byte("old-encrypted-data"), 0600); err != nil {
		t.Fatal(err)
	}
	get := callHandler(handleGet, "GET", id, "", nil)
	if get.Code != 200 || get.Header().Get("X-Sync-Rev") != "0" || get.Body.String() != "old-encrypted-data" {
		t.Fatalf("legacy snapshot cannot be read: %d %v", get.Code, get.Header())
	}
}

func TestConcurrentSnapshotReads(t *testing.T) {
	testStore(t)
	id := "test-concurrent"
	callHandler(handlePut, "PUT", id, strings.Repeat("a", 100000), nil)
	rateLimitsMu.Lock()
	delete(rateLimits, id)
	rateLimitsMu.Unlock()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			get := callHandler(handleGet, "GET", id, "", nil)
			rev := get.Header().Get("X-Sync-Rev")
			expected := bytes.Repeat([]byte("a"), 100000)
			if rev == "2" {
				expected = bytes.Repeat([]byte("b"), 100000)
			} else if rev != "1" {
				t.Errorf("unexpected revision: %q", rev)
			}
			if !bytes.Equal(get.Body.Bytes(), expected) {
				t.Error("snapshot body does not match its revision")
			}
		}()
	}
	put := callHandler(handlePut, "PUT", id, strings.Repeat("b", 100000), map[string]string{"X-Expected-Rev": "1"})
	wg.Wait()
	var result struct{ Rev int }
	if err := json.Unmarshal(put.Body.Bytes(), &result); err != nil || result.Rev != 2 {
		t.Fatalf("second upload failed: %s", put.Body.String())
	}
}
