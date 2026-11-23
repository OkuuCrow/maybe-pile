/**
 * Optional global Quick Capture shortcut (opt-in, off by default).
 *
 * Registration is failure-tolerant: if another app owns the accelerator,
 * Electron's `register` returns false (or throws for a malformed accelerator);
 * we report that to Settings instead of crashing, and the in-app shortcut
 * (Ctrl/Cmd+Shift+N) keeps working.
 */
export interface ShortcutRegistry {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export interface ShortcutState {
  accelerator: string | null;
  registered: boolean;
  message: string | null;
}

export class QuickCaptureShortcut {
  private current: string | null = null;
  state: ShortcutState = { accelerator: null, registered: false, message: null };

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onTrigger: () => void,
  ) {}

  apply(settings: { globalShortcut: boolean; accelerator: string }): ShortcutState {
    if (this.current && (!settings.globalShortcut || settings.accelerator !== this.current)) {
      try {
        this.registry.unregister(this.current);
      } catch {
        /* already gone */
      }
      this.current = null;
    }
    if (!settings.globalShortcut) {
      this.state = { accelerator: null, registered: false, message: null };
      return this.state;
    }
    if (this.current === settings.accelerator) return this.state;
    let ok = false;
    try {
      ok = this.registry.register(settings.accelerator, this.onTrigger);
    } catch {
      ok = false;
    }
    if (ok) {
      this.current = settings.accelerator;
      this.state = { accelerator: settings.accelerator, registered: true, message: null };
    } else {
      this.state = {
        accelerator: settings.accelerator,
        registered: false,
        message: `${settings.accelerator} is already used by another app (or not allowed by the system). Choose a different shortcut; Ctrl/Cmd+Shift+N still works inside Maybe Pile.`,
      };
    }
    return this.state;
  }

  dispose(): void {
    if (this.current) this.registry.unregister(this.current);
    this.current = null;
  }
}
