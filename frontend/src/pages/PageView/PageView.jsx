import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Star, Menu, ChevronRight, Copy, Download, SmilePlus, RotateCcw, Trash2, MoveHorizontal, Check } from 'lucide-react';
import { getPage, updatePage, setFavorite, restorePage, purgePage } from '../../lib/api';
import { usePageIndex, ancestorsOf } from '../../lib/pageIndex';
import { on } from '../../lib/events';
import { countWords } from '../../lib/content';
import { relativeTime } from '../../lib/time';
import PageActions from '../../components/PageActions';
import PageIcon from '../../components/PageIcon';
import IconPicker from '../../components/IconPicker';
import ExportDialog from '../../components/ExportDialog';
import useSettings from '../../store/settingsStore';
import { MenuItem } from '../../components/Popover';
import { toast } from '../../components/Toasts';
import { askConfirm } from '../../components/ConfirmDialog';
import BacklinksPanel from './BacklinksPanel';

// The editors are big (BlockNote, Excalidraw): load them only when needed.
const Editor = lazy(() => import('./Editor'));
const CanvasPage = lazy(() => import('./CanvasPage'));

function Spinner() {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-accent" />
    </div>
  );
}

function Breadcrumbs({ id }) {
  const { t } = useTranslation();
  const byId = usePageIndex((s) => s.byId);
  const trail = ancestorsOf(byId, id);
  if (!trail.length) return null;
  return (
    <nav className="flex min-w-0 items-center gap-1 overflow-hidden text-sm text-neutral-500">
      {trail.slice(-3).map((p) => (
        <span key={p.id} className="flex min-w-0 items-center gap-1">
          <Link to={`/page/${p.id}`} className="flex min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <PageIcon page={p} size={14} />
            <span className="truncate">{p.title || t('page.untitled')}</span>
          </Link>
          <ChevronRight size={14} className="shrink-0 opacity-50" />
        </span>
      ))}
    </nav>
  );
}

export default function PageView() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { sidebarVisible, openSidebar, collapseForCanvas } = useOutletContext();
  const meta = usePageIndex((s) => s.byId[id]);
  const indexLoaded = usePageIndex((s) => s.loaded);
  const [page, setPage] = useState(undefined); // undefined: loading, null: not here
  const [title, setTitle] = useState('');
  const [words, setWords] = useState(0);
  const [iconOpen, setIconOpen] = useState(false);
  const iconBtn = useRef(null);
  const titleRef = useRef(null);
  const titleFocused = useRef(false);
  const titleTimer = useRef(null);
  const editorRef = useRef(null);
  const canvasRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const defaultFullWidth = useSettings((st) => st.fullWidth);

  const load = useCallback(async () => {
    const p = await getPage(id);
    setPage(p);
    if (p) {
      setTitle(p.title || '');
      if (p.type !== 'canvas') setWords(countWords(p.content_json));
    }
    return p;
  }, [id]);

  const pageRef = useRef(page);
  pageRef.current = page;

  useEffect(() => {
    setPage(undefined);
    load().then((p) => {
      if (p?.type === 'canvas') collapseForCanvas?.();
    });
    // A page opened from a link before the first sync brought it down.
    return on('pages-changed', (ids) => {
      if (!ids.includes(id)) return;
      if (!pageRef.current) {
        load();
        return;
      }
      // "Full width" changed on another device.
      if (pageRef.current.type !== 'canvas') {
        getPage(id).then((p) => p && setPage((prev) => (prev && prev.id === p.id ? { ...prev, canvas_settings: p.canvas_settings } : prev)));
      }
    });
  }, [id, load, collapseForCanvas]);

  // Renamed elsewhere (another device, the sidebar): follow it.
  useEffect(() => {
    if (meta && !titleFocused.current && meta.title !== undefined) setTitle(meta.title || '');
  }, [meta?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = titleRef.current;
    if (el && el.tagName === 'TEXTAREA') {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title, page?.type]);

  function saveTitle(value) {
    clearTimeout(titleTimer.current);
    titleTimer.current = null;
    if (value !== (usePageIndex.getState().byId[id]?.title ?? '')) updatePage(id, { title: value });
  }

  function onTitleChange(value) {
    setTitle(value);
    clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => saveTitle(value), 500);
  }

  useEffect(() => () => titleTimer.current && saveTitle(titleRef.current?.value ?? ''), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContentSave = useCallback(
    (content_json, opts) => {
      updatePage(id, { content_json }, opts);
      setWords(countWords(content_json));
    },
    [id]
  );
  const handleInkSave = useCallback((ink_json, opts) => updatePage(id, { ink_json }, opts), [id]);
  const handleSettingsChange = useCallback((canvas_settings) => updatePage(id, { canvas_settings }), [id]);

  if (page === undefined) return <Spinner />;
  if (page === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-neutral-500">
        {!indexLoaded ? <Spinner /> : <p>{t('page.notFound')}</p>}
        <Link to="/" className="text-accent-dark hover:underline">
          {t('nav.home')}
        </Link>
      </div>
    );
  }

  const current = meta || page;
  const isCanvas = page.type === 'canvas';
  const edited = current.updated_at ? relativeTime(current.updated_at, i18n.language) : '';

  // "Full width" is kept per page (like Notion) in the page's settings; until
  // a page has its own choice it follows the device default from Settings.
  const fullWidth = page.canvas_settings?.fullWidth ?? defaultFullWidth;
  function toggleFullWidth() {
    const settings = { ...(page.canvas_settings || {}), fullWidth: !fullWidth };
    setPage((p) => ({ ...p, canvas_settings: settings }));
    updatePage(id, { canvas_settings: settings });
  }

  const pageMenuItems = (close) => (
    <>
      {!isCanvas && (
        <MenuItem
          icon={MoveHorizontal}
          hint={fullWidth ? <Check size={14} className="text-accent-dark" /> : null}
          onClick={() => {
            close();
            toggleFullWidth();
          }}
        >
          {t('page.fullWidth')}
        </MenuItem>
      )}
      <MenuItem
        icon={Download}
        onClick={() => {
          close();
          setExporting(true);
        }}
      >
        {t('page.export')}
      </MenuItem>
      {!isCanvas && (
        <MenuItem
          icon={Copy}
          onClick={async () => {
            close();
            try {
              await navigator.clipboard.writeText(editorRef.current?.toMarkdown() || '');
              toast(t('page.copiedMarkdown'));
            } catch {
              toast(t('page.copyFailed'));
            }
          }}
        >
          {t('page.copyMarkdown')}
        </MenuItem>
      )}
    </>
  );

  const exportDialog = (
    <ExportDialog
      open={exporting}
      onClose={() => setExporting(false)}
      kind={isCanvas ? 'canvas' : 'doc'}
      title={title}
      icon={current.icon}
      getDoc={() => editorRef.current}
      getNotebook={async () => canvasRef.current?.getExportData()}
    />
  );

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-2 px-3">
      {!sidebarVisible && (
        <button
          type="button"
          onClick={openSidebar}
          title={t('sidebar.expand')}
          className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <Menu size={18} />
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Breadcrumbs id={id} />
        {isCanvas && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span ref={iconBtn}>
              <button type="button" onClick={() => setIconOpen(true)} className="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <PageIcon page={current} size={18} />
              </button>
            </span>
            <input
              ref={titleRef}
              className="min-w-0 flex-1 truncate bg-transparent text-base font-semibold outline-none placeholder:text-neutral-400"
              value={title}
              placeholder={t('page.untitled')}
              onFocus={() => (titleFocused.current = true)}
              onBlur={() => {
                titleFocused.current = false;
                saveTitle(title);
              }}
              onChange={(e) => onTitleChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </div>
        )}
      </div>
      {edited && <span className="hidden shrink-0 text-xs text-neutral-400 sm:inline">{t('page.edited', { when: edited })}</span>}
      <button
        type="button"
        title={current.is_favorite ? t('page.unfavorite') : t('page.favorite')}
        onClick={() => setFavorite(id, !current.is_favorite)}
        className={`rounded-lg p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${current.is_favorite ? 'text-amber-500' : 'text-neutral-400'}`}
      >
        <Star size={18} fill={current.is_favorite ? 'currentColor' : 'none'} />
      </button>
      <PageActions page={current} extra={pageMenuItems} iconSize={18} />
    </div>
  );

  const trashBanner = current.is_deleted ? (
    <div className="flex flex-wrap items-center justify-center gap-3 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300">
      {t('page.inTrash')}
      <button type="button" onClick={() => restorePage(id)} className="flex items-center gap-1 font-medium hover:underline">
        <RotateCcw size={14} /> {t('page.restore')}
      </button>
      <button
        type="button"
        onClick={async () => {
          if (!(await askConfirm(t('page.deleteForeverConfirm'), { confirmLabel: t('page.deleteForever') }))) return;
          await purgePage(id);
          navigate('/trash');
        }}
        className="flex items-center gap-1 font-medium hover:underline"
      >
        <Trash2 size={14} /> {t('page.deleteForever')}
      </button>
    </div>
  ) : null;

  const iconPicker = (
    <IconPicker anchorRef={iconBtn} open={iconOpen} onClose={() => setIconOpen(false)} onPick={(icon) => updatePage(id, { icon })} />
  );

  if (isCanvas) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-neutral-200 dark:border-neutral-800">{header}</div>
        {trashBanner}
        <div className="min-h-0 flex-1">
          <Suspense fallback={<Spinner />}>
            <CanvasPage ref={canvasRef} key={page.id} page={page} onChange={handleInkSave} onSettingsChange={handleSettingsChange} />
          </Suspense>
        </div>
        {iconPicker}
        {exportDialog}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 bg-white/85 backdrop-blur dark:bg-neutral-900/85">{header}</div>
      {trashBanner}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto w-full px-4 pb-24 pt-6 sm:pt-10 ${fullWidth ? 'max-w-none sm:px-10 lg:px-16' : 'max-w-3xl sm:px-12'}`}>
          <div className="group mb-2 px-[54px] max-sm:px-3">
            <span ref={iconBtn} className="inline-block">
              {current.icon ? (
                <button type="button" onClick={() => setIconOpen(true)} className="mb-2 rounded-xl p-1 text-5xl leading-none hover:bg-neutral-100 dark:hover:bg-neutral-800">
                  {current.icon}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIconOpen(true)}
                  className="mb-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-neutral-400 opacity-100 transition hover:bg-neutral-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-neutral-800"
                >
                  <SmilePlus size={16} /> {t('page.addIcon')}
                </button>
              )}
            </span>
            <textarea
              ref={titleRef}
              rows={1}
              className="block w-full resize-none overflow-hidden bg-transparent text-3xl font-bold leading-tight outline-none placeholder:text-neutral-300 sm:text-4xl dark:placeholder:text-neutral-600"
              value={title}
              placeholder={t('page.untitled')}
              onFocus={() => (titleFocused.current = true)}
              onBlur={() => {
                titleFocused.current = false;
                saveTitle(title);
              }}
              onChange={(e) => onTitleChange(e.target.value.replace(/\n/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (editorRef.current) editorRef.current.focus();
                  else document.querySelector('.quarc-editor .ProseMirror')?.focus();
                }
              }}
            />
          </div>
          <Suspense fallback={<Spinner />}>
            <Editor key={page.id} ref={editorRef} page={page} onSave={handleContentSave} />
          </Suspense>
          <div className="px-[54px] max-sm:px-3">
            <BacklinksPanel pageId={page.id} />
            <p className="mt-6 text-xs text-neutral-400">{t('page.wordCount', { count: words })}</p>
          </div>
        </div>
      </div>
      {iconPicker}
      {exportDialog}
    </div>
  );
}
