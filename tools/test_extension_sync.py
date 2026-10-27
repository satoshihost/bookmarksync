import html
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = {
    extension: {
        name: (ROOT / extension / name).read_text()
        for name in ('background.js', 'lib/sync.js', 'lib/bookmarks.js', 'popup/popup.js', 'popup/popup.html')
    }
    for extension in ('extension', 'extension-firefox')
}
HARNESS = r'''
const sources = SOURCES;
const results = [];
const quiet = { log() {}, warn() {}, error() {} };
const assert = (value, message) => { if (!value) throw new Error(message); };
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function rejects(fn, text) {
    let error;
    try { await fn(); } catch (e) { error = e; }
    assert(error && (!text || error.message.includes(text)), 'Expected rejection: ' + text);
}
async function test(name, fn) {
    try { await fn(); results.push({ name, passed: true }); }
    catch (e) { results.push({ name, passed: false, error: e.stack }); }
}
function environment(source, initial = {}, hooks = {}) {
    const state = { serverUrl: 'https://example.com', syncId: 'test-sync', passphrase: 'test-only',
        lastSyncRev: 1, syncDataVersion: 2, localDirty: false, syncInterval: 1, ...initial };
    const alarms = new Map();
    const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); } });
    const calls = { uploads: 0, downloads: 0, restores: 0, infos: 0, active: 0, maxActive: 0 };
    const chrome = {
        runtime: { id: 'test-extension', onInstalled: event(), onStartup: event(), onMessage: event() },
        storage: { onChanged: event(), local: {
            get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(k => k in state).map(k => [k, state[k]])),
            set: async value => { Object.assign(state, value); },
            remove: async keys => { for (const key of keys) delete state[key]; },
            clear: async () => { for (const key of Object.keys(state)) delete state[key]; }
        } },
        alarms: { onAlarm: event(),
            get: async name => alarms.get(name),
            create: async (name, options) => { alarms.set(name, { name, ...options }); },
            clear: async name => alarms.delete(name)
        },
        bookmarks: { onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event(),
            getTree: async () => [{ id: '0', children: [] }]
        }
    };
    let serverRev = 2;
    const getInfo = async () => {
        calls.infos++; calls.active++; calls.maxActive = Math.max(calls.maxActive, calls.active);
        try { return hooks.info ? await hooks.info() : { rev: serverRev }; }
        finally { calls.active--; }
    };
    const download = async () => {
        calls.downloads++;
        return hooks.download ? await hooks.download() : { data: new Uint8Array(), rev: serverRev };
    };
    const upload = async (url, id, data, expected) => {
        calls.uploads++; calls.expectedRev = expected;
        if (hooks.upload) return await hooks.upload();
        return { rev: ++serverRev };
    };
    const restore = async (tree, options) => {
        calls.restores++; calls.restoreOptions = options;
        chrome.bookmarks.onCreated.handlers.forEach(fn => fn());
        if (hooks.restore) await hooks.restore();
    };
    const validate = rev => { if (!Number.isSafeInteger(rev) || rev < 0) throw new Error('Invalid revision'); };
    const api = new Function('chrome', 'console', 'getInfo', 'downloadBlob', 'uploadBlob', 'encrypt', 'decrypt', 'restoreBookmarks', 'validateRevision', 'setTimeout', 'clearTimeout',
        source + '\nreturn { performSync, onBookmarkChange, ensureSyncAlarm };')(
        chrome, quiet, getInfo, download, upload, async () => new Uint8Array(),
        async () => JSON.stringify({ version: 1, bookmarks: [{ children: [] }] }), restore, validate, () => 1, () => {}
    );
    const message = msg => new Promise(resolve => {
        chrome.runtime.onMessage.handlers[0](msg, { id: chrome.runtime.id }, resolve);
    });
    return { ...api, state, alarms, calls, chrome, message };
}
async function runSuite(label, source) {
    await test(label + ': missing alarm restored at worker startup', async () => {
        const e = environment(source['background.js']); await tick();
        assert(e.alarms.get('autoSync')?.periodInMinutes === 1, 'No one-minute alarm');
    });
    await test(label + ': manual and alarm sync serialize', async () => {
        const e = environment(source['background.js']);
        await Promise.all([e.performSync('autoSync'), e.message({ action: 'sync' })]);
        assert(e.calls.maxActive === 1, 'Concurrent network operations');
        assert(e.calls.restores === 1 && e.state.lastSyncRev === 2, 'Duplicate or missing restore');
    });
    await test(label + ': downloaded revision, not earlier info revision, is saved', async () => {
        const e = environment(source['background.js'], {}, { download: async () => ({ data: new Uint8Array(), rev: 3 }) });
        await e.performSync();
        assert(e.state.lastSyncRev === 3, 'Saved /info revision instead of snapshot revision');
        assert(!e.state.localDirty, 'Restore triggered a re-upload');
    });
    await test(label + ': edit while downloading is retained, not overwritten', async () => {
        const paused = gate();
        const e = environment(source['background.js'], {}, { download: () => paused.promise });
        const run = e.performSync(); await tick();
        e.onBookmarkChange(); paused.resolve({ data: new Uint8Array(), rev: 2 });
        await rejects(() => run, 'Bookmarks changed');
        assert(e.state.localDirty && e.calls.restores === 0 && e.state.lastSyncRev === 1, 'Local edit lost');
    });
    await test(label + ': edit during upload remains pending', async () => {
        const paused = gate();
        const e = environment(source['background.js'], { localDirty: true }, { info: async () => ({ rev: 1 }), upload: () => paused.promise });
        const run = e.performSync(); await tick(); e.onBookmarkChange(); paused.resolve({ rev: 2 }); await run;
        assert(e.state.localDirty && e.state.lastSyncRev === 2, 'Upload cleared a newer edit');
        assert(e.calls.expectedRev === 1, 'Upload did not send base revision');
    });
    await test(label + ': failed request schedules retry and next success clears error', async () => {
        let offline = true;
        const e = environment(source['background.js'], {}, { info: async () => { if (offline) throw new Error('offline'); return { rev: 1 }; } });
        await rejects(() => e.performSync(), 'offline');
        assert(e.alarms.has('pendingSync') && e.state.lastSyncError === 'offline', 'No retry/error state');
        offline = false; await e.performSync();
        assert(e.state.lastSyncError === null, 'Stale error remains');
    });
    await test(label + ': failed restore does not advance revision or permit upload', async () => {
        const e = environment(source['background.js'], {}, { restore: async () => { throw new Error('restore failure'); } });
        await rejects(() => e.performSync(), 'restore failure');
        assert(e.state.lastSyncRev === 1 && e.state.restorePending, 'Failed restore accepted');
        await rejects(() => e.performSync('manual', { direction: 'upload' }), 'interrupted');
        assert(!e.calls.uploads, 'Partial tree uploaded');
    });
    await test(label + ': interrupted restore recovery preserves safety backup', async () => {
        const e = environment(source['background.js'], { restorePending: true });
        await e.performSync('manual', { direction: 'download' });
        assert(e.calls.restoreOptions.preserveSafetyBackup && !e.state.restorePending, 'Recovery backup lost');
    });
    await test(label + ': legacy cached revision requires explicit choice', async () => {
        const e = environment(source['background.js'], { syncDataVersion: undefined });
        const result = await e.performSync();
        assert(result.action === 'choose' && !e.calls.uploads && !e.calls.downloads, 'Unsafe migration');
        await e.performSync('manual', { direction: 'download' });
        assert(e.state.syncDataVersion === 2 && e.state.lastSyncRev === 2, 'Migration not completed');
    });
    await test(label + ': conflict keeps both copies untouched', async () => {
        const e = environment(source['background.js'], { localDirty: true });
        await rejects(() => e.performSync(), 'Both');
        assert(!e.calls.uploads && !e.calls.downloads && e.state.localDirty, 'Conflict overwrote data');
    });
    await test(label + ': forced download recreates alarm', async () => {
        const e = environment(source['background.js']); await tick(); e.alarms.clear();
        const result = await e.message({ action: 'sync', direction: 'download' });
        assert(result.success && e.alarms.has('autoSync'), 'Forced download failed to restore polling');
    });
    await test(label + ': local import is queued and marked dirty only after restore', async () => {
        const e = environment(source['background.js']);
        const result = await e.message({ action: 'restore', bookmarks: [{ children: [] }] });
        assert(result.success && e.state.localDirty && !e.state.restorePending && !e.calls.uploads, 'Import state incorrect');
    });
    await test(label + ': switching sync identity does not reuse old revision', async () => {
        const e = environment(source['background.js']);
        const result = await e.message({ action: 'sync', settings: { serverUrl: 'https://example.com', syncId: 'different', passphrase: 'test-only' } });
        assert(result.action === 'choose' && !e.calls.uploads && !e.calls.downloads, 'Old revision reused');
    });
    await test(label + ': message errors are not reported as success', async () => {
        const e = environment(source['background.js'], {}, { info: async () => { throw new Error('offline'); } });
        const result = await e.message({ action: 'sync' });
        assert(result.success === false && result.error === 'offline', 'False success');
    });
    await test(label + ': reset clears scheduling through worker', async () => {
        const e = environment(source['background.js']); await tick();
        await e.message({ action: 'reset' });
        assert(!e.alarms.size && !e.state.syncId, 'Reset left sync configured');
    });
    await test(label + ': transport bypasses stale cache and validates paired revision', async () => {
        const calls = [];
        const fetch = async (url, options = {}) => {
            calls.push({ url, options });
            if (url.endsWith('/info')) return new Response(JSON.stringify({ rev: 191 }));
            if (options.method === 'PUT') return new Response(JSON.stringify({ rev: 192 }));
            return new Response(options.cache === 'no-store' ? 'fresh' : 'stale', { headers: { 'X-Sync-Rev': '191' } });
        };
        const api = new Function('fetch', source['lib/sync.js'] + '\nreturn { downloadBlob, getInfo, uploadBlob };')(fetch);
        const result = await api.downloadBlob('https://example.com', 'test-sync');
        assert(result.rev === 191 && new TextDecoder().decode(result.data) === 'fresh', 'Cached blob used');
        await api.getInfo('https://example.com', 'test-sync');
        await api.uploadBlob('https://example.com', 'test-sync', new Uint8Array(), 191);
        assert(calls.every(c => c.options.cache === 'no-store' && c.options.signal), 'Caching or no timeout');
        assert(calls.at(-1).options.headers['X-Expected-Rev'] === '191', 'Missing conflict precondition');
    });
    await test(label + ': old server and malformed revisions fail safely', async () => {
        for (const header of [null, '', '-1', 'abc', '9007199254740992']) {
            const fetch = async () => new Response('data', { headers: header === null ? {} : { 'X-Sync-Rev': header } });
            const download = new Function('fetch', source['lib/sync.js'] + '\nreturn downloadBlob;')(fetch);
            await rejects(() => download('https://example.com', 'test-sync'));
        }
        const api = new Function('fetch', source['lib/sync.js'] + '\nreturn { getInfo, uploadBlob };')(async () => new Response('{}'));
        await rejects(() => api.getInfo('https://example.com', 'test-sync'), 'Invalid');
        await rejects(() => api.uploadBlob('https://example.com', 'test-sync', new Uint8Array(), 1), 'Invalid');
    });
    await test(label + ': restore API failure is propagated', async () => {
        const chrome = { storage: { local: { set: async () => {} } }, bookmarks: {
            getTree: async () => [{ children: [{ id: '1', title: 'Bookmarks bar', children: [] }] }],
            create: async () => { throw new Error('create failed'); }
        } };
        const restore = new Function('chrome', 'console', source['lib/bookmarks.js'] + '\nreturn restoreBookmarks;')(chrome, quiet);
        await rejects(() => restore([{ children: [{ title: 'Bookmarks bar', children: [{ title: 'Test', url: 'https://example.com' }] }] }]), 'create failed');
    });
    await test(label + ': real browser HTTP cache cannot supply an old snapshot', async () => {
        const id = 'cache-' + label;
        const address = location.origin + '/sync/' + id;
        assert(await (await fetch(address)).text() === 'old snapshot', 'Cache warmup failed');
        assert(await (await fetch(address)).text() === 'old snapshot', 'Expected old response in cache');
        const download = new Function('fetch', source['lib/sync.js'] + '\nreturn downloadBlob;')(fetch);
        const fresh = await download(location.origin, id);
        assert(fresh.rev === 191 && new TextDecoder().decode(fresh.data) === 'new snapshot', 'Old cached snapshot restored');
    });
    await test(label + ': popup buttons execute the background engine and recover UI state', async () => {
        const e = environment(source['background.js'], { syncDataVersion: undefined });
        const doc = new DOMParser().parseFromString(source['popup/popup.html'], 'text/html');
        e.chrome.runtime.sendMessage = e.message;
        const popup = new Function('document', 'chrome', 'window', 'countBookmarks', 'confirm', 'setTimeout',
            source['popup/popup.js'] + '\nreturn { initializePopup, syncNow, firstSync, forceDownload, forceUpload };')(
            doc, e.chrome, {}, () => 0, () => false, () => 1);
        await popup.initializePopup();
        assert(doc.getElementById('firstSyncPanel').style.display === 'flex', 'Migration choice hidden');
        await popup.syncNow(); await tick();
        assert(e.calls.uploads === 0 && e.calls.downloads === 0, 'Migration ran without choice');
        await popup.firstSync('download'); await tick();
        assert(e.state.syncDataVersion === 2 && e.calls.downloads === 1, 'First download bypassed engine');
        assert(doc.getElementById('firstSyncPanel').style.display === 'none', 'Choice remains after success');
        assert(!doc.getElementById('syncNowBtn').disabled, 'Button remains disabled');
        await popup.forceUpload(); await popup.forceDownload();
        assert(e.calls.uploads === 0 && e.calls.downloads === 1, 'Cancelled action modified data');
        await popup.syncNow(); await tick();
        assert(e.calls.downloads === 1, 'Unchanged revision restored again');
    });
    await test(label + ': popup delegates sync and contains no direct network/restore path', async () => {
        const code = source['popup/popup.js'];
        new Function(code);
        assert(!/\b(getInfo|uploadBlob|downloadBlob|restoreBookmarks|lockSync|unlockSync)\s*\(/.test(code), 'Duplicate popup sync engine');
        assert(code.includes("action: 'sync'") && code.includes("action: 'restore'"), 'Worker messages missing');
    });
}
(async () => {
    for (const [label, source] of Object.entries(sources)) await runSuite(label, source);
    document.getElementById('result').textContent = JSON.stringify(results);
})().catch(e => { document.getElementById('result').textContent = JSON.stringify([{ passed: false, error: e.stack }]); });
'''


def main():
    chromium = shutil.which('chromium') or shutil.which('google-chrome')
    if not chromium:
        raise SystemExit('Install Chromium or Google Chrome to run the isolated JavaScript tests.')
    script = HARNESS.replace('SOURCES', json.dumps(SOURCES), 1).replace('</script', '<\\/script')
    page = ('<!doctype html><pre id="result">RUNNING</pre><script>' + script + '</script>').encode()

    cache_requests = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            if self.path.startswith('/sync/cache-'):
                count = cache_requests.get(self.path, 0)
                cache_requests[self.path] = count + 1
                self.send_header('Cache-Control', 'max-age=600' if count == 0 else 'no-store')
                self.send_header('X-Sync-Rev', '190' if count == 0 else '191')
                self.end_headers()
                self.wfile.write(b'old snapshot' if count == 0 else b'new snapshot')
            else:
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(page)

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='browser-sync-tests-') as profile:
                run = subprocess.run([
                    chromium, '--headless', '--disable-gpu', '--no-first-run',
                    '--no-default-browser-check', '--disable-background-networking',
                    '--user-data-dir=' + profile, '--dump-dom', '--virtual-time-budget=10000',
                    'http://127.0.0.1:' + str(server.server_port)
                ], capture_output=True, text=True, timeout=60)
        finally:
            server.shutdown()
    match = re.search(r'<pre id="result">(.*?)</pre>', run.stdout, re.S)
    if run.returncode or not match or match.group(1) == 'RUNNING':
        raise SystemExit('Browser tests did not finish:\n' + run.stderr[-4000:] + '\n' + run.stdout[:1000])
    results = json.loads(html.unescape(match.group(1)))
    for result in results:
        print(('PASS ' if result['passed'] else 'FAIL ') + result.get('name', 'runner'))
        if not result['passed']:
            print(result['error'])
    passed = sum(result['passed'] for result in results)
    print(f'{passed}/{len(results)} checks passed')
    raise SystemExit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
