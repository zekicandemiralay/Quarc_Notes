import { useTranslation } from 'react-i18next';
import Popover from './Popover';

const EMOJIS = [
  '📄', '📝', '📓', '📔', '📒', '📕', '📗', '📘', '📙', '📚', '✏️', '🖊️', '🖋️', '🖍️', '📌', '📎',
  '💡', '🧠', '🎯', '✅', '☑️', '⭐', '🔥', '⚡', '🚀', '🎉', '❤️', '💼', '🏠', '🏢', '🏫', '🎓',
  '🧪', '🔬', '🧮', '📐', '📊', '📈', '🗂️', '🗃️', '🗓️', '⏰', '🧾', '💰', '🛒', '🍳', '🍎', '☕',
  '✈️', '🗺️', '🏖️', '🏔️', '🎵', '🎬', '📷', '🎨', '🎮', '⚽', '🏃', '🧘', '💊', '🌱', '🐾', '🌙',
  '💻', '🖥️', '📱', '⚙️', '🔧', '🔒', '🔑', '📦', '🧩', '🗒️', '📋', '🔖', '💬', '📣', '❓', '❗',
];

export default function IconPicker({ anchorRef, open, onClose, onPick }) {
  const { t } = useTranslation();
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} className="w-[19rem] p-2">
      <div className="grid grid-cols-8 gap-0.5">
        {EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => {
              onPick(e);
              onClose();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-xl hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            {e}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          onPick(null);
          onClose();
        }}
        className="mt-2 w-full rounded-lg px-2 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
      >
        {t('page.removeIcon')}
      </button>
    </Popover>
  );
}
