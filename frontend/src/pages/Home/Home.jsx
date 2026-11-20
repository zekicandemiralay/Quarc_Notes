import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FilePlus2, NotebookPen, Search, Star, Clock, Link2, Shapes, Hand } from 'lucide-react';
import useAuthStore from '../../store/authStore';
import { usePageIndex } from '../../lib/pageIndex';
import { createPage } from '../../lib/api';
import { relativeTime } from '../../lib/time';
import PageShell from '../../components/PageShell';
import PageIcon from '../../components/PageIcon';

function greetingKey() {
  const h = new Date().getHours();
  if (h < 5) return 'home.evening';
  if (h < 12) return 'home.morning';
  if (h < 18) return 'home.afternoon';
  return 'home.evening';
}

function PageCard({ page }) {
  const { t, i18n } = useTranslation();
  return (
    <Link
      to={`/page/${page.id}`}
      className="group flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3.5 transition hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-800/60 dark:hover:border-neutral-700"
    >
      <PageIcon page={page} size={22} />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{page.title || t('page.untitled')}</div>
        <div className="mt-0.5 truncate text-xs text-neutral-400">
          {page.type === 'canvas' ? t('page.notebook') : t('page.document')} · {relativeTime(page.updated_at, i18n.language)}
        </div>
      </div>
    </Link>
  );
}

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { openSwitcher } = useOutletContext();
  const user = useAuthStore((s) => s.user);
  const pages = usePageIndex((s) => s.pages);
  const loaded = usePageIndex((s) => s.loaded);
  const live = pages.filter((p) => !p.is_deleted);
  const favorites = live.filter((p) => p.is_favorite);
  const recent = [...live].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 12);

  async function create(type) {
    const page = await createPage({ type });
    navigate(`/page/${page.id}`);
  }

  const actions = [
    { icon: FilePlus2, label: t('home.newPage'), hint: t('home.newPageHint'), onClick: () => create('doc') },
    { icon: NotebookPen, label: t('home.newNotebook'), hint: t('home.newNotebookHint'), onClick: () => create('canvas') },
    { icon: Search, label: t('home.search'), hint: t('home.searchHint'), onClick: openSwitcher },
  ];

  return (
    <PageShell width="max-w-4xl">
      <h1 className="mb-1 mt-4 text-2xl font-bold sm:text-3xl">{t(greetingKey(), { name: user?.username || '' })}</h1>
      <p className="mb-8 text-sm text-neutral-500">{t('home.subtitle')}</p>

      <div className="mb-10 grid gap-3 sm:grid-cols-3">
        {actions.map(({ icon: Icon, label, hint, onClick }) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            className="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-left transition hover:border-accent/60 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-800/60 dark:hover:border-accent/50"
          >
            <span className="rounded-lg bg-accent/15 p-2 text-accent-dark dark:text-amber-300">
              <Icon size={20} />
            </span>
            <span>
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-xs text-neutral-500">{hint}</span>
            </span>
          </button>
        ))}
      </div>

      {favorites.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-500">
            <Star size={15} /> {t('sidebar.favorites')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {favorites.map((p) => (
              <PageCard key={p.id} page={p} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-500">
          <Clock size={15} /> {t('home.recent')}
        </h2>
        {recent.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {recent.map((p) => (
              <PageCard key={p.id} page={p} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-400 dark:border-neutral-700">
            {loaded ? t('home.empty') : '…'}
          </p>
        )}
      </section>

      <section className="rounded-xl bg-neutral-100 p-4 text-sm text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
        <h2 className="mb-2 font-semibold">{t('home.tipsTitle')}</h2>
        <ul className="space-y-1.5">
          <li className="flex gap-2">
            <Link2 size={16} className="mt-0.5 shrink-0 text-accent" /> {t('home.tipLinks')}
          </li>
          <li className="flex gap-2">
            <Shapes size={16} className="mt-0.5 shrink-0 text-accent" /> {t('home.tipShapes')}
          </li>
          <li className="flex gap-2">
            <Hand size={16} className="mt-0.5 shrink-0 text-accent" /> {t('home.tipGestures')}
          </li>
        </ul>
      </section>
    </PageShell>
  );
}
