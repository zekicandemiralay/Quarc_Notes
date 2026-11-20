import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, FilePlus2, NotebookPen, CornerDownLeft } from 'lucide-react';
import Modal from './Modal';
import PageIcon from './PageIcon';
import { usePageIndex } from '../lib/pageIndex';
import { search, createPage } from '../lib/api';
import { relativeTime } from '../lib/time';

// Ctrl/Cmd+K: jump to any page by title (instant, offline) or by its text
// (full-text, from the local cache and the server), or create one.
export default function QuickSwitcher({ open, onClose }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const pages = usePageIndex((s) => s.pages);
  const [q, setQ] = useState('');
  const [textHits, setTextHits] = useState([]);
  const [active, setActive] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setTextHits([]);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setTextHits([]);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      const hits = await search(query);
      if (alive) setTextHits(hits);
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    const live = pages.filter((p) => !p.is_deleted);
    let results;
    if (!query) {
      results = [...live].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 8).map((p) => ({ kind: 'page', page: p }));
    } else {
      const titleHits = live
        .filter((p) => (p.title || '').toLowerCase().includes(query))
        .sort((a, b) => {
          const as = (a.title || '').toLowerCase().startsWith(query) ? 0 : 1;
          const bs = (b.title || '').toLowerCase().startsWith(query) ? 0 : 1;
          return as - bs || (b.updated_at || '').localeCompare(a.updated_at || '');
        })
        .slice(0, 8);
      const seen = new Set(titleHits.map((p) => p.id));
      results = titleHits.map((p) => ({ kind: 'page', page: p, snippet: textHits.find((h) => h.id === p.id)?.snippet }));
      for (const h of textHits) {
        if (seen.has(h.id) || results.length >= 14) continue;
        const p = live.find((x) => x.id === h.id);
        if (p) results.push({ kind: 'page', page: p, snippet: h.snippet });
      }
      results.push({ kind: 'create', type: 'doc', title: q.trim() });
      results.push({ kind: 'create', type: 'canvas', title: q.trim() });
    }
    return results;
  }, [q, pages, textHits]);

  useEffect(() => {
    if (active >= items.length) setActive(Math.max(0, items.length - 1));
  }, [items.length, active]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  async function choose(item) {
    onClose();
    if (item.kind === 'page') navigate(`/page/${item.page.id}`);
    else {
      const p = await createPage({ title: item.title, type: item.type });
      navigate(`/page/${p.id}`);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      choose(items[active]);
    }
  }

  return (
    <Modal open={open} onClose={onClose} top className="max-w-xl">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-700">
        <Search size={18} className="shrink-0 text-neutral-400" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t('search.switcherPlaceholder')}
          className="h-14 w-full bg-transparent text-base outline-none placeholder:text-neutral-400"
        />
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {!q.trim() && <div className="px-3 pb-1 pt-1 text-xs font-medium text-neutral-400">{t('home.recent')}</div>}
        {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-neutral-400">{t('home.empty')}</p>}
        {items.map((item, i) => (
          <button
            key={item.kind === 'page' ? item.page.id : `create-${item.type}`}
            type="button"
            data-idx={i}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(item)}
            className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left ${i === active ? 'bg-neutral-100 dark:bg-neutral-700/70' : ''}`}
          >
            {item.kind === 'page' ? (
              <>
                <PageIcon page={item.page} size={18} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.page.title || t('page.untitled')}</span>
                  {item.snippet ? (
                    <span className="block truncate text-xs text-neutral-500 [&_mark]:rounded [&_mark]:bg-amber-200 [&_mark]:px-0.5 dark:[&_mark]:bg-amber-500/40 dark:[&_mark]:text-white" dangerouslySetInnerHTML={{ __html: item.snippet }} />
                  ) : (
                    <span className="block text-xs text-neutral-400">{relativeTime(item.page.updated_at, i18n.language)}</span>
                  )}
                </span>
              </>
            ) : (
              <>
                {item.type === 'doc' ? <FilePlus2 size={18} className="mt-0.5 text-accent" /> : <NotebookPen size={18} className="mt-0.5 text-accent" />}
                <span className="flex-1 text-sm">{t(item.type === 'doc' ? 'search.createPage' : 'search.createNotebook', { title: item.title })}</span>
              </>
            )}
            {i === active && <CornerDownLeft size={14} className="mt-1 shrink-0 text-neutral-400" />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
