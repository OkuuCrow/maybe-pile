# Cover wall (§14.2, Full mode)

A poster grid of finished items (More → Cover wall): sort by completion date, rating or title; filter by
year and type; size slider.

- Virtualized: only visible rows are rendered (tested with large libraries in jsdom up to the item cap;
  not profiled on real hardware); uses cached thumbnails, never full-resolution art.
- Keyboard grid with roving tabindex: arrows, Home/End, Enter opens. Every cover has an accessible name
  (title, rating, finish date); missing art uses the generated placeholder. Adult art stays blurred.
- **Save as image** captures the visible wall as PNG through the same capture + save pipeline as the share
  card. Provider artwork belongs to its owners — share accordingly.
