# Extension Icons

This directory needs three PNG icon files:

- `icon-16.png` - 16x16 pixels (toolbar icon)
- `icon-48.png` - 48x48 pixels (extension management page)
- `icon-128.png` - 128x128 pixels (Chrome Web Store)

## Design Suggestions

**Theme:** A simple book/bookmark icon with a sync symbol

**Colors:** Purple gradient (#667eea to #764ba2) to match the UI

## Temporary Solution

For testing, you can:
1. Use any 16x16, 48x48, and 128x128 PNG files as placeholders
2. Generate simple icons at https://www.favicon-generator.org/
3. Use an AI image generator with prompt: "minimalist bookmark sync icon, purple gradient, flat design"

## Creating Icons

Quick method using ImageMagick (if installed):
```bash
# Create simple placeholder (purple square with "BS" text)
convert -size 128x128 -background "#667eea" -fill white \
  -gravity center -pointsize 72 -font Arial label:"📚" icon-128.png

convert -resize 48x48 icon-128.png icon-48.png
convert -resize 16x16 icon-128.png icon-16.png
```
