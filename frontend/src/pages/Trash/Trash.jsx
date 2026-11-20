import { useTranslation } from 'react-i18next';
import { RotateCcw, Trash2 } from 'lucide-react';
import { restorePage, purgePage, emptyTrash } from '../../lib/api';
import { usePageIndex } from '../../lib/pageIndex';
import { relativeTime } from '../../lib/time';
import PageShell from '../../components/PageShell';
import PageIcon from '../../components/PageIcon';
import { toast } from '../../components/Toasts';

export default function Trash() {
  const { t, i18n } = useTranslation();
  const pages = usePageIndex((s) => s.pages);
  const byId = usePageIndex((s) => s.byId);
  // Only the top-most trashed pages: their sub-pages come back with them.
  const trashed = pages
    .filter((p) => p.is_deleted && !(p.parent_id && byId[p.parent_id]?.is_deleted))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const countUnder = (id) => pages.filter((p) => p.is_deleted && p.parent_id === id).length;

  async function handleRestore(p) {
    await restorePage(p.id);
    toast(t('page.restored', { title: p.title || t('page.untitled') }));
  }

  async function handleDeleteForever(p) {
    if (!window.confirm(t('page.deleteForeverConfirm'))) return;
    await purgePage(p.id);
  }

  async function handleEmpty() {
    if (!window.confirm(t('trash.emptyConfirm', { count: trashed.length }))) return;
    await emptyTrash();
  }

  return (
    <PageShell
      title={t('sidebar.trash')}
      actions={
        trashed.length > 0 && (
          <button type="button" onClick={handleEmpty} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10">
            <Trash2 size={15} /> {t('trash.empty')}
          </button>
        )
      }
    >
      {trashed.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-400 dark:border-neutral-700">{t('trash.nothing')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {trashed.map((p) => {
            const kids = countUnder(p.id);
            return (
              <div key={p.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <PageIcon page={p} size={18} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{p.title || t('page.untitled')}</div>
                  <div className="text-xs text-neutral-400">
                    {t('trash.deletedWhen', { when: relativeTime(p.updated_at, i18n.language) })}
                    {kids > 0 && ` · ${t('trash.withSubpages', { count: kids })}`}
                  </div>
                </div>
                <button type="button" title={t('page.restore')} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-accent-dark hover:bg-accent/10 dark:text-amber-300" onClick={() => handleRestore(p)}>
                  <RotateCcw size={15} /> <span className="hidden sm:inline">{t('page.restore')}</span>
                </button>
                <button type="button" title={t('page.deleteForever')} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10" onClick={() => handleDeleteForever(p)}>
                  <Trash2 size={15} /> <span className="hidden sm:inline">{t('page.deleteForever')}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
