import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';

// The app's own "Are you sure?" question. Use it instead of window.confirm for anything that can't be undone.
// Why: the Windows app shows this page from the server, and Tauri's dialog plugin (there for the Save-as dialog)
// replaces window.confirm with an async function whose native dialog the page is not allowed to open. A Promise is
// truthy, so `if (!window.confirm(...)) return;` went straight on and deleted without asking. This dialog works the
// same in every browser and app.
const useConfirm = create(() => ({ ask: null }));

/** Shows the question; resolves true only when the person presses the confirm button. */
export function askConfirm(message, { confirmLabel } = {}) {
  return new Promise((resolve) => {
    useConfirm.getState().ask?.resolve(false); // a new question replaces an unanswered one
    useConfirm.setState({ ask: { message, confirmLabel, resolve } });
  });
}

function answer(value) {
  const { ask } = useConfirm.getState();
  if (!ask) return;
  useConfirm.setState({ ask: null });
  ask.resolve(value);
}

export default function ConfirmDialog() {
  const { t } = useTranslation();
  const ask = useConfirm((s) => s.ask);
  const cancelRef = useRef(null);
  useEffect(() => {
    if (ask) cancelRef.current?.focus(); // Enter or Space right away must not delete anything
  }, [ask]);

  return (
    <Modal open={!!ask} onClose={() => answer(false)}>
      <p className="px-5 pt-5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-200">{ask?.message}</p>
      <div className="flex justify-end gap-2 px-5 pb-5 pt-4">
        <button
          ref={cancelRef}
          type="button"
          onClick={() => answer(false)}
          className="rounded-lg px-4 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700"
        >
          {t('confirm.cancel')}
        </button>
        <button
          type="button"
          onClick={() => answer(true)}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          {ask?.confirmLabel || t('confirm.delete')}
        </button>
      </div>
    </Modal>
  );
}
