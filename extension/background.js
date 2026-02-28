// Background service worker for BookmarkSync

// Installation handler
chrome.runtime.onInstalled.addListener((details) => {
    console.log('BookmarkSync installed:', details.reason);
    
    if (details.reason === 'install') {
        // First install - set defaults
        chrome.storage.local.set({
            serverUrl: 'https://sync.satoshihost.com',
            syncInterval: 30,
            autoSync: false
        });
    }
});

// Alarm handler for auto-sync
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'autoSync') {
        performSync();
    }
});

// Bookmark change listeners (for future auto-sync on change)
chrome.bookmarks.onCreated.addListener(() => {
    console.log('Bookmark created');
});

chrome.bookmarks.onRemoved.addListener(() => {
    console.log('Bookmark removed');
});

chrome.bookmarks.onChanged.addListener(() => {
    console.log('Bookmark changed');
});

chrome.bookmarks.onMoved.addListener(() => {
    console.log('Bookmark moved');
});

async function performSync() {
    console.log('Performing auto-sync...');
    
    try {
        const settings = await chrome.storage.local.get([
            'serverUrl',
            'syncId',
            'passphrase',
            'autoSync'
        ]);
        
        if (!settings.autoSync || !settings.syncId || !settings.passphrase) {
            console.log('Sync not configured or disabled');
            return;
        }
        
        // TODO: Implement actual sync logic
        console.log('Sync would happen here');
        
        // Update last sync time
        await chrome.storage.local.set({
            lastSync: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Sync failed:', error);
    }
}

// Keep service worker alive (if needed)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Message received:', message);
    
    if (message.action === 'sync') {
        performSync().then(() => {
            sendResponse({ success: true });
        }).catch((error) => {
            sendResponse({ success: false, error: error.message });
        });
        return true; // Keep message channel open for async response
    }
});

console.log('BookmarkSync service worker loaded');
