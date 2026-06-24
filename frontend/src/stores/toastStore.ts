// Authorized by HUB-1578 — toast queue store (Zustand) for the Operator Console shell.
// Consumers anywhere in the app emit via addToast(...). The <Toaster /> mounted in
// ConsoleShell renders + auto-dismisses (with prefers-reduced-motion respect).
import { create } from 'zustand';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  /** Override auto-dismiss timeout. Default: 5000ms per FR.
   * Skipped entirely when prefers-reduced-motion: reduce (operator dismisses manually). */
  autoDismissMs?: number;
}

export interface ToastInput {
  variant: ToastVariant;
  message: string;
  autoDismissMs?: number;
}

export interface ToastState {
  toasts: readonly Toast[];
}

export interface ToastActions {
  addToast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
  clearAll: () => void;
}

export type ToastStore = ToastState & ToastActions;

let nextId = 0;
const generateId = (): string => `toast-${++nextId}`;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: ({ variant, message, autoDismissMs }) => {
    const id = generateId();
    set((s) => ({
      toasts: [...s.toasts, { id, variant, message, autoDismissMs }],
    }));
    return id;
  },
  dismissToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  clearAll: () => {
    set({ toasts: [] });
  },
}));

export const useToasts = (): readonly Toast[] => useToastStore((s) => s.toasts);
