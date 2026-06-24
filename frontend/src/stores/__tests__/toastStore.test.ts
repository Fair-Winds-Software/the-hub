// Authorized by HUB-1578 — toastStore unit tests
import { beforeEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../toastStore';

describe('toastStore (HUB-1578)', () => {
  beforeEach(() => {
    useToastStore.getState().clearAll();
  });

  it('initial state: toasts is empty', () => {
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('addToast appends a toast and returns its id', () => {
    const id = useToastStore.getState().addToast({
      variant: 'warning',
      message: 'Watch out',
    });
    expect(typeof id).toBe('string');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      id,
      variant: 'warning',
      message: 'Watch out',
    });
  });

  it('multiple toasts queue in insertion order', () => {
    useToastStore.getState().addToast({ variant: 'info', message: 'first' });
    useToastStore.getState().addToast({ variant: 'error', message: 'second' });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0].message).toBe('first');
    expect(toasts[1].message).toBe('second');
  });

  it('dismissToast removes the matching toast', () => {
    const id1 = useToastStore.getState().addToast({ variant: 'info', message: 'A' });
    const id2 = useToastStore.getState().addToast({ variant: 'info', message: 'B' });
    useToastStore.getState().dismissToast(id1);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].id).toBe(id2);
  });

  it('clearAll removes everything', () => {
    useToastStore.getState().addToast({ variant: 'info', message: 'A' });
    useToastStore.getState().addToast({ variant: 'info', message: 'B' });
    useToastStore.getState().clearAll();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
