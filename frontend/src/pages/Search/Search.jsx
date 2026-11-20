import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon } from 'lucide-react';
import { search } from '../../lib/api';
import { relativeTime } from '../../lib/time';
import PageShell from '../../components/PageShell';
import PageIcon from '../../components/PageIcon';

export default function Search() {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      const r = await search(q);
      if (alive) setResults(r);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <PageShell title={t('sidebar.search')}>
      <div className="relative">
        <SearchIcon size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          autoFocus
          className="w-full rounded-xl border border-neutral-300 bg-transparent py-2.5 pl-10 pr-4 text-base outline-none focus:border-accent dark:border-neutral-700"
          placeholder={t('search.placeholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {results && (
        <div className="mt-4 flex flex-col gap-1">
          {results.length === 0 && <p className="text-sm text-neutral-400">{t('search.noResults')}</p>}
          {results.map((r) => (
            <Link key={r.id} to={`/page/${r.id}`} className="flex gap-3 rounded-lg px-3 py-2.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
              <PageIcon page={r} size={18} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.title || t('page.untitled')}</div>
                {r.snippet ? (
                  <div
                    className="line-clamp-2 text-sm text-neutral-500 [&_mark]:rounded [&_mark]:bg-amber-200 [&_mark]:px-0.5 dark:[&_mark]:bg-amber-500/40 dark:[&_mark]:text-white"
                    dangerouslySetInnerHTML={{ __html: r.snippet }}
                  />
                ) : (
                  <div className="text-xs text-neutral-400">{relativeTime(r.updated_at, i18n.language)}</div>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
