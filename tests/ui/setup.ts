// jsdom gaps used by the renderer.
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!(globalThis as { CSS?: unknown }).CSS) (globalThis as { CSS?: unknown }).CSS = {};
const css = (globalThis as unknown as { CSS: { escape?: (s: string) => string } }).CSS;
if (!css.escape) css.escape = (s: string) => s.replace(/([^\w-])/g, '\\$1');
Element.prototype.scrollIntoView ??= () => undefined;
