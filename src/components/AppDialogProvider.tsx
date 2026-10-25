import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmOverlay } from './ConfirmOverlay';
import { MessageOverlay } from './MessageOverlay';

interface DialogOptions {
  title?: string;
  kind?: 'info' | 'warning' | 'error';
  okLabel?: string;
  cancelLabel?: string;
}

interface AppDialogs {
  confirm: (message: string, options?: DialogOptions) => Promise<boolean>;
  message: (message: string, options?: DialogOptions) => Promise<void>;
}

interface DialogRequest {
  id: number;
  confirmation: boolean;
  message: string;
  options: DialogOptions;
  resolve: (approved: boolean) => void;
}

const AppDialogContext = createContext<AppDialogs | null>(null);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const pending = useRef<DialogRequest[]>([]);
  const nextId = useRef(1);
  const mounted = useRef(true);
  const [current, setCurrent] = useState<DialogRequest | null>(null);

  useEffect(() => {
    mounted.current = true;
    const requests = pending.current;
    return () => {
      mounted.current = false;
      for (const request of requests.splice(0)) request.resolve(false);
    };
  }, []);

  const enqueue = useCallback((confirmation: boolean, text: string, options: DialogOptions = {}) => {
    if (!mounted.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const request: DialogRequest = { id: nextId.current++, confirmation, message: text, options, resolve };
      pending.current.push(request);
      if (pending.current.length === 1) setCurrent(request);
    });
  }, []);

  const finish = useCallback((id: number, approved: boolean) => {
    if (pending.current[0]?.id !== id) return;
    const request = pending.current.shift()!;
    if (mounted.current) setCurrent(pending.current[0] ?? null);
    request.resolve(approved);
  }, []);

  const dialogs = useMemo<AppDialogs>(() => ({
    confirm: (text, options) => enqueue(true, text, options),
    message: async (text, options) => { await enqueue(false, text, options); },
  }), [enqueue]);

  return (
    <AppDialogContext.Provider value={dialogs}>
      {children}
      {current?.confirmation ? (
        <ConfirmOverlay
          key={current.id}
          isOpen
          title={current.options.title ?? 'Confirm action'}
          message={current.message}
          confirmText={current.options.okLabel ?? 'Confirm'}
          cancelText={current.options.cancelLabel ?? 'Cancel'}
          onConfirm={() => finish(current.id, true)}
          onClose={() => finish(current.id, false)}
        />
      ) : current ? (
        <MessageOverlay
          key={current.id}
          isOpen
          title={current.options.title ?? 'SIMM'}
          message={current.message}
          type={current.options.kind === 'error' ? 'error' : 'info'}
          onClose={() => finish(current.id, false)}
        />
      ) : null}
    </AppDialogContext.Provider>
  );
}

export function useAppDialogs(): AppDialogs {
  const dialogs = useContext(AppDialogContext);
  if (!dialogs) throw new Error('useAppDialogs requires AppDialogProvider');
  return dialogs;
}
