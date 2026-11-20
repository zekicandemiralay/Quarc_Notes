import { useEffect } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';

export const useToasts = create(() => ({ toasts: [] }));

export function toast(message, { action, duration = 5000 } = {}) {
  const id = crypto.randomUUID();
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, message, action, duration }] }));
  return id;
}

export function dismissToast(id) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

function Toast({ item }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration]);
  return (
    <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-2xl dark:bg-neutral-100 dark:text-neutral-900">
      <span className="flex-1">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="font-semibold text-amber-400 hover:underline dark:text-amber-700"
          onClick={() => {
            item.action.onClick();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" onClick={() => dismissToast(item.id)} className="opacity-60 hover:opacity-100">
        <X size={16} />
      </button>
    </div>
  );
}

export default function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[1200] flex flex-col items-center gap-2 px-3">
      {toasts.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  );
}
