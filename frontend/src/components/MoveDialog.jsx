import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerDownRight, Home } from 'lucide-react';
import Modal from './Modal';
import PageIcon from './PageIcon';
import { usePageIndex } from '../lib/pageIndex';
import { movePage } from '../lib/api';

// "Move to…": pick a new parent page (or the top level). Works with touch,
// where drag-and-drop in the sidebar doesn't.
export default function MoveDialog({ pageId, open, onClose }) {
  const { t } = useTranslation();
  const pages = usePageIndex((s) => s.pages);
  const byId = usePageIndex((s) => s.byId);
  const [q, setQ] = useState('');

  const blocked = useMemo(() => {
    // The page itself and everything under it can't be a destination.
    const out = new Set([pageId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of pages) {
        if (p.parent_id && out.has(p.parent_id) && !out.has(p.id)) {
          out.add(p.id);
          grew = true;
        }
      }
    }
    return out;
  }, [pages, pageId]);

  const options = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pages
      .filter((p) => !p.is_deleted && !blocked.has(p.id))
      .filter((p) => !needle || (p.title || '').toLowerCase().includes(needle))
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      .slice(0, 100);
  }, [pages, blocked, q]);

  async function choose(parentId) {
    await movePage(pageId, parentId, Date.now());
    onClose();
  }

  const current = byId[pageId];
  return (
    <Modal open={open} onClose={onClose} title={t('page.moveTo')}>
      <div className="p-3">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('page.moveSearch')}
          className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-neutral-600"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <button
          type="button"
          disabled={!current?.parent_id}
          onClick={() => choose(null)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-700"
        >
          <Home size={16} className="text-neutral-400" /> {t('page.topLevel')}
        </button>
        {options.map((p) => {
          const parent = p.parent_id ? byId[p.parent_id] : null;
          return (
            <button
              key={p.id}
              type="button"
              disabled={current?.parent_id === p.id}
              onClick={() => choose(p.id)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-700"
            >
              <PageIcon page={p} size={16} />
              <span className="flex-1 truncate">{p.title || t('page.untitled')}</span>
              {parent && (
                <span className="flex max-w-[40%] items-center gap-1 truncate text-xs text-neutral-400">
                  <CornerDownRight size={12} /> {parent.title || t('page.untitled')}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
