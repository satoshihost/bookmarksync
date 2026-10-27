#!/usr/bin/env python3
"""Create a de-duplicated Full Browser Sync backup from browser exports.

The first input is preferred when the same URL appears in more than one
source. URLs absent from it are appended from the remaining exports. Root
and folder titles are retained, but browser-local bookmark IDs are omitted:
the extension assigns fresh IDs on import.
"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def bookmark_entries(nodes, path=()):
    for node in nodes:
        title = node.get("title", "")
        if "url" in node:
            yield path, title, node["url"]
        yield from bookmark_entries(node.get("children", []), path + (title,))


def ensure_folder(root, titles):
    current = root
    for title in titles:
        child = next(
            (item for item in current["children"] if "children" in item and item["title"] == title),
            None,
        )
        if child is None:
            child = {"title": title, "children": []}
            current["children"].append(child)
        current = child
    return current


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("inputs", nargs="+", type=Path)
    args = parser.parse_args()

    output_root = {"title": "", "children": []}
    seen_urls = set()
    added = 0

    # First input has precedence. Subsequent exports only fill URL gaps.
    for input_path in args.inputs:
        data = json.loads(input_path.read_text(encoding="utf-8"))
        if data.get("version") != 1 or not isinstance(data.get("bookmarks"), list):
            raise ValueError(f"{input_path} is not a version 1 bookmark backup")
        for folder_path, title, url in bookmark_entries(data["bookmarks"]):
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            folder = ensure_folder(output_root, folder_path[1:])
            folder["children"].append({"title": title, "url": url})
            added += 1

    result = {
        "version": 1,
        "created": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "bookmarks": [output_root],
    }
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {added} unique bookmarks to {args.output}")


if __name__ == "__main__":
    main()
