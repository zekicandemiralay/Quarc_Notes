import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import { getBacklinks } from '../../lib/api';
import { on } from '../../lib/events';
import { usePageIndex } from '../../lib/pageIndex';
import PageIcon from '../../components/PageIcon';

// Pages linking here — computed from the local cache, so it works offline
// and updates as soon as a link is typed (on this or another device).
export default function BacklinksPanel({ pageId }) {
  const { t } = useTranslation();
  const [links, setLinks] = useState([]);
  const pages = usePageIndex((s) => s.pages);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      getBacklinks(pageId).then((l) => {
        if (alive) setLinks(l);
      });
    refresh();
    const off = on('pages-changed', refresh);
    return () => {
      alive = false;
      off();
    };
  }, [pageId, pages.length]);

  return (
    <div className="mt-12 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-neutral-500">
        <Link2 size={15} /> {t('page.backlinks')}
        {links.length > 0 && <span className="text-neutral-400">· {links.length}</span>}
      </h3>
      {links.length === 0 ? (
        <p className="text-sm text-neutral-400">{t('page.noBacklinks')}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {links.map((l) => (
            <Link
              key={l.id}
              to={`/page/${l.id}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <PageIcon page={l} size={15} />
              <span className="truncate">{l.title || t('page.untitled')}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
