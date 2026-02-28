// Bookmarks module for BookmarkSync
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
 * Import bookmarks from JSON format
 * @param {Object} data - Bookmarks data object
 * @returns {Promise<void>}
 */
async function importFromJSON(data) {
    // TODO: Implement bookmark import
    // This is complex - need to handle:
    // - Merging vs replacing
    // - Duplicate detection
    // - Folder structure preservation
    console.log('Import not yet implemented', data);
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

// Export functions
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getAllBookmarks, exportToJSON, importFromJSON, countBookmarks };
}
