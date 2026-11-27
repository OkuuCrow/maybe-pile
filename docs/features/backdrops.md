# Backdrops (§15.6)

Item pages can show a soft background (Settings → Appearance → Backdrops; per-item override under the item's
*Backdrop* card in Full mode):

- **Off**, **Ambient** (default; colors from the cover, computed locally — works offline), **Banner image**
  (background/banner artwork slot), **Full-page blurred**.
- **Readability guarantee**: a scrim in the theme's background color is placed between the image and the
  page. Its opacity is solved for **WCAG 2.2 AA (4.5:1)** against the image's darkest and brightest sampled
  colors (pure black and white when unknown), with exact sRGB compositing; the intensity setting can only
  add scrim. Tested over bright, dark and busy synthetic images.
- **Reduce effects / high contrast** turns backdrops off; `prefers-contrast: more` and
  `prefers-reduced-transparency` also do. No parallax or animation.
- Spoiler/adult rules: blurred adult art → Ambient; hidden art → off.
- Performance: palettes are computed in main from the small cached thumbnail and cached in
  `artwork_palettes`; the blurred style uses CSS blur on cached images (no full-resolution decode in main).
- Storage: Settings → Advanced → Images and storage (cache size, cap — default 1 GB, *Clear cached images*);
  LRU eviction removes only re-downloadable images that you did not select; never your own images.
