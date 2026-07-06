import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getBacklinks } from '../../lib/api';

export default function BacklinksPanel({ pageId }) {
  const { t } = useTranslation();
  const [links, setLinks] = useState([]);

  useEffect(() => {
    getBacklinks(pageId).then(setLinks);
  }, [pageId]);

  if (!links.length) {
    return (
      <div className="mt-8 border-t border-neutral-200 pt-4 text-sm text-neutral-400 dark:border-neutral-700">
        {t('page.noBacklinks')}
      </div>
    );
  }

  return (
    <div className="mt-8 border-t border-neutral-200 pt-4 dark:border-neutral-700">
      <h3 className="mb-2 text-sm font-medium text-neutral-500">{t('page.backlinks')}</h3>
      <div className="flex flex-col gap-1">
        {links.map((l) => (
          <Link key={l.id} to={`/page/${l.id}`} className="text-sm text-accent-dark hover:underline">
            {l.icon ? `${l.icon} ` : '📄 '}
            {l.title || 'Untitled'}
          </Link>
        ))}
      </div>
    </div>
  );
}
