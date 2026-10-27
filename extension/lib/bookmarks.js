// Bookmarks module for Full Browser Sync
// Helpers for reading and writing Chrome bookmarks

/**
 * Get all bookmarks as a tree
 * @returns {Promise<Array>} - Bookmark tree
 */
async function getAllBookmarks() {
    const tree = await chrome.bookmarks.getTree();
    return tree;
}

/**
 * Export bookmarks to JSON format
 * @returns {Promise<Object>} - Bookmarks data object
 */
async function exportToJSON() {
    const bookmarks = await getAllBookmarks();
    return {
        version: 1,
        created: new Date().toISOString(),
        bookmarks: bookmarks
    };
}

/**
 * Helper to match top-level folders across different browsers (Chrome vs Firefox).
 * Chrome roots: "Bookmarks bar", "Other bookmarks", "Mobile bookmarks"
 * Firefox roots: "Bookmarks Toolbar", "Bookmarks Menu", "Other Bookmarks", "Mobile Bookmarks"
 * @param {Array} targetRootChildren - Children of root node in the live browser
 * @param {string} sourceTitle - Title of folder in the source tree
 * @param {number} sourceIndex - Index position of folder in the source tree
 * @returns {Object|null} - Matched target folder node
 */
function findMatchingTargetFolder(targetRootChildren, sourceTitle, sourceIndex) {
    if (!targetRootChildren || !targetRootChildren.length) return null;

    const norm = (s) => (s || '').trim().toLowerCase();
    const title = norm(sourceTitle);

    const toolbarAliases = ['bookmarks bar', 'bookmarks toolbar', 'toolbar'];
    const otherAliases = ['other bookmarks', 'other', 'unfiled', 'unfiled bookmarks'];
    const mobileAliases = ['mobile bookmarks', 'mobile'];
    const menuAliases = ['bookmarks menu', 'menu'];

    function getFolderCategory(t) {
        if (toolbarAliases.includes(t)) return 'toolbar';
        if (otherAliases.includes(t)) return 'other';
        if (mobileAliases.includes(t)) return 'mobile';
        if (menuAliases.includes(t)) return 'menu';
        return 'custom';
    }

    const sourceCat = getFolderCategory(title);

    // 1. Exact title match (case-insensitive)
    let matched = targetRootChildren.find(c => norm(c.title) === title);
    if (matched) return matched;

    // 2. Cross-browser category match (e.g. "Bookmarks bar" <-> "Bookmarks Toolbar")
    if (sourceCat !== 'custom') {
        matched = targetRootChildren.find(c => getFolderCategory(norm(c.title)) === sourceCat);
        if (matched) return matched;
    }

    // 3. Fallback for Firefox "Bookmarks Menu" syncing to Chrome (which lacks a Menu root)
    if (sourceCat === 'menu') {
        matched = targetRootChildren.find(c => getFolderCategory(norm(c.title)) === 'toolbar')
               || targetRootChildren.find(c => getFolderCategory(norm(c.title)) === 'other');
        if (matched) return matched;
    }

    // 4. Index-based fallback
    if (targetRootChildren[sourceIndex]) {
        return targetRootChildren[sourceIndex];
    }

    return null;
}

/**
 * Full-replacement import from a backup bookmark tree.
 * Keeps browser-owned root folders but clears and recreates their contents.
 * @param {Array} bookmarkTree - The bookmarks array from a backup object
 * @returns {Promise<void>}
 */
async function restoreBookmarks(bookmarkTree, { preserveSafetyBackup = false } = {}) {
    console.log('Starting bookmark restore...');

    // 1. VALIDATION BEFORE TOUCHING ANYTHING
    if (!Array.isArray(bookmarkTree) || !bookmarkTree[0] || !Array.isArray(bookmarkTree[0].children)) {
        throw new Error('Invalid bookmark tree structure — restore aborted to prevent data loss');
    }

    const backupRoot = bookmarkTree[0];
    const incomingBookmarkCount = countBookmarks(backupRoot);

    const tree = await chrome.bookmarks.getTree();
    const root = tree[0];
    const currentBookmarkCount = countBookmarks(root);

    // Safety guard: do not allow auto-wiping a rich bookmark set with an empty tree (0 bookmarks)
    if (incomingBookmarkCount === 0 && currentBookmarkCount > 5) {
        throw new Error(`Restore aborted: server payload contains 0 bookmarks but local browser has ${currentBookmarkCount} bookmarks.`);
    }

    // 2. AUTOMATIC PRE-RESTORE LOCAL SAFETY BACKUP
    if (!preserveSafetyBackup) {
        await chrome.storage.local.set({
            autoSafetyBackup: {
                timestamp: new Date().toISOString(),
                bookmarks: tree
            }
        });
        console.log(`Auto safety backup created (${currentBookmarkCount} bookmarks saved)`);
    }

    // 3. Delete all content inside each top-level browser folder, but keep the folders themselves.
    for (const child of root.children) {
        if (child.children && child.children.length > 0) {
            // Reverse order to avoid index shifting issues
            for (let i = child.children.length - 1; i >= 0; i--) {
                try {
                    await chrome.bookmarks.removeTree(child.children[i].id);
                } catch (e) {
                    console.warn('Could not delete bookmark:', e);
                    throw e;
                }
            }
        }
    }

    // 4. Restore from backup tree
    for (let index = 0; index < backupRoot.children.length; index++) {
        const sourceFolder = backupRoot.children[index];

        // Match source folder to target browser root folder category
        const targetFolder = findMatchingTargetFolder(root.children, sourceFolder.title, index);

        if (targetFolder && sourceFolder.children) {
            // Recreate contents into matched existing folder
            for (const child of sourceFolder.children) {
                await restoreNode(child, targetFolder.id);
            }
        } else {
            // Fallback parent MUST be a valid root child ID
            const fallbackParentId = (root.children[1] || root.children[0])?.id;
            if (fallbackParentId) {
                const newFolder = await chrome.bookmarks.create({
                    parentId: fallbackParentId,
                    title: sourceFolder.title
                });
                if (sourceFolder.children) {
                    for (const child of sourceFolder.children) {
                        await restoreNode(child, newFolder.id);
                    }
                }
            }
        }
    }

    console.log('Bookmark restore complete');
}

/**
 * Recursively recreate a bookmark node under parentId.
 * @param {Object} node - Bookmark tree node from a backup
 * @param {string} parentId - Parent folder ID in the live browser tree
 */
async function restoreNode(node, parentId) {
    if (!parentId || !node) return;
    const title = typeof node.title === 'string' ? node.title : '';

    try {
        if (node.url) {
            // Skip Firefox internal "place:" smart bookmarks (e.g. place:sort=8...) which Chrome rejects
            if (typeof node.url === 'string' && node.url.startsWith('place:')) {
                return;
            }
            await chrome.bookmarks.create({
                parentId,
                title,
                url: node.url
            });
        } else if (node.children !== undefined) {
            const newFolder = await chrome.bookmarks.create({
                parentId,
                title
            });
            if (Array.isArray(node.children)) {
                for (const child of node.children) {
                    await restoreNode(child, newFolder.id);
                }
            }
        }
    } catch (e) {
        console.warn('Could not restore bookmark node:', node.title || node.url, e);
        throw e;
    }
}

/**
 * Count total bookmarks (excluding folders)
 * @param {Object} node - Bookmark tree node
 * @returns {number} - Count of bookmarks
 */
function countBookmarks(node) {
    let count = 0;
    if (node.url) count = 1;
    if (node.children) {
        node.children.forEach(child => {
            count += countBookmarks(child);
        });
    }
    return count;
}

// Export functions (for Node.js/testing environments)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getAllBookmarks, exportToJSON, restoreBookmarks, restoreNode, countBookmarks, findMatchingTargetFolder };
}
