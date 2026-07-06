import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { search } from '../../lib/api';

export default function Search() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);

  async function handleChange(e) {
    const value = e.target.value;
    setQ(value);
    if (!value.trim()) {
      setResults(null);
      return;
    }
    setResults(await search(value));
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-10">
      <input
        autoFocus
        className="w-full rounded-lg border border-neutral-300 bg-transparent px-4 py-2 text-lg outline-none focus:border-accent dark:border-neutral-600"
        placeholder={t('search.placeholder')}
        value={q}
        onChange={handleChange}
      />
      {results && (
        <div className="mt-4 flex flex-col gap-1">
          {results.length === 0 && <p className="text-sm text-neutral-400">{t('search.noResults')}</p>}
          {results.map((r) => (
            <Link
              key={r.id}
              to={`/page/${r.id}`}
              className="rounded-lg px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <div className="font-medium">
                {r.icon ? `${r.icon} ` : r.type === 'canvas' ? '✏️ ' : '📄 '}
                {r.title || 'Untitled'}
              </div>
              {r.snippet && (
                <div
                  className="text-sm text-neutral-500"
                  dangerouslySetInnerHTML={{ __html: r.snippet }}
                />
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
