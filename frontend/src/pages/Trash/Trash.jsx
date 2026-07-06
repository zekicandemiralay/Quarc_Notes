import { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listPages, restorePage } from '../../lib/api';
import { db } from '../../lib/db';
import { apiUrl } from '../../lib/apiUrl';

export default function Trash() {
  const { t } = useTranslation();
  const { refreshSidebar } = useOutletContext();
  const [pages, setPages] = useState([]);

  const refresh = useCallback(() => {
    listPages({ trash: true }).then(setPages);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRestore(id) {
    await restorePage(id);
    refresh();
    refreshSidebar();
  }

  async function handleDeleteForever(id) {
    await fetch(apiUrl(`/api/pages/${id}/permanent`), { method: 'DELETE', credentials: 'include' });
    await db.pages.delete(id);
    refresh();
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <h1 className="mb-4 text-xl font-semibold">{t('sidebar.trash')}</h1>
      <div className="flex flex-col gap-1">
        {pages.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <span>
              {p.icon ? `${p.icon} ` : p.type === 'canvas' ? '✏️ ' : '📄 '}
              {p.title || 'Untitled'}
            </span>
            <div className="flex gap-3 text-sm">
              <button className="text-accent-dark hover:underline" onClick={() => handleRestore(p.id)}>
                {t('page.restore')}
              </button>
              <button className="text-red-500 hover:underline" onClick={() => handleDeleteForever(p.id)}>
                {t('page.deleteForever')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
