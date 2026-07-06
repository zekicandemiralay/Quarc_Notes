import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getPage, updatePage, trashPage } from '../../lib/api';
import Editor from './Editor';
import CanvasPage from './CanvasPage';
import BacklinksPanel from './BacklinksPanel';

export default function PageView() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refreshSidebar } = useOutletContext();
  const [page, setPage] = useState(null);
  const [title, setTitle] = useState('');

  useEffect(() => {
    let cancelled = false;
    getPage(id).then((p) => {
      if (!cancelled) {
        setPage(p);
        setTitle(p?.title || '');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleTitleBlur = useCallback(async () => {
    if (!page || title === page.title) return;
    await updatePage(page.id, { title });
    refreshSidebar();
  }, [page, title, refreshSidebar]);

  const handleContentChange = useCallback(
    async (content_json) => {
      await updatePage(id, { content_json });
    },
    [id]
  );

  const handleInkChange = useCallback(
    async (ink_json) => {
      await updatePage(id, { ink_json });
    },
    [id]
  );

  async function handleTrash() {
    await trashPage(id);
    refreshSidebar();
    navigate('/');
  }

  if (!page) return <div className="p-8 text-neutral-400">Loading…</div>;

  if (page.type === 'canvas') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-700">
          <input
            className="flex-1 bg-transparent text-lg font-semibold outline-none"
            value={title}
            placeholder={t('page.untitled')}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
          />
          <button onClick={handleTrash} className="text-sm text-neutral-400 hover:text-red-500">
            🗑️ {t('page.delete')}
          </button>
        </div>
        <div className="flex-1">
          <CanvasPage page={page} onChange={handleInkChange} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="mb-4 flex items-center justify-between">
        <input
          className="w-full bg-transparent text-3xl font-bold outline-none"
          value={title}
          placeholder={t('page.untitled')}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={handleTitleBlur}
        />
        <button onClick={handleTrash} className="ml-4 whitespace-nowrap text-sm text-neutral-400 hover:text-red-500">
          🗑️ {t('page.delete')}
        </button>
      </div>
      <Editor key={page.id} page={page} onChange={handleContentChange} />
      <BacklinksPanel pageId={page.id} />
    </div>
  );
}
