import { useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Star, StarOff, FilePlus2, NotebookPen, Copy, FolderInput, Trash2 } from 'lucide-react';
import Popover, { MenuItem, MenuSeparator } from './Popover';
import MoveDialog from './MoveDialog';
import { toast } from './Toasts';
import { createPage, duplicatePage, setFavorite, trashPage, restorePage } from '../lib/api';

// The "⋯" menu for a page: favorite, add sub-page/notebook, duplicate,
// move, trash (with undo) — plus any page-specific `extra` items.
export default function PageActions({ page, extra = null, buttonClassName = '', iconSize = 16, onTrashed }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  if (!page) return null;

  const close = () => setOpen(false);

  async function addChild(type) {
    close();
    const child = await createPage({ parent_id: page.id, type });
    navigate(`/page/${child.id}`);
  }

  async function duplicate() {
    close();
    const copy = await duplicatePage(page.id, { titleSuffix: ` (${t('page.copySuffix')})` });
    if (copy) {
      navigate(`/page/${copy.id}`);
      toast(t('page.duplicated'));
    }
  }

  async function trash() {
    close();
    await trashPage(page.id);
    if (location.pathname === `/page/${page.id}`) navigate('/');
    onTrashed?.();
    toast(t('page.movedToTrash', { title: page.title || t('page.untitled') }), {
      action: { label: t('page.undo'), onClick: () => restorePage(page.id) },
    });
  }

  return (
    <>
      <span ref={btn} className="inline-flex">
        <button
          type="button"
          title={t('page.actions')}
          aria-label={t('page.actions')}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={buttonClassName || 'rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700'}
        >
          <MoreHorizontal size={iconSize} />
        </button>
      </span>
      <Popover anchorRef={btn} open={open} onClose={close} align="end" className="w-60">
        <MenuItem
          icon={page.is_favorite ? StarOff : Star}
          onClick={() => {
            close();
            setFavorite(page.id, !page.is_favorite);
          }}
        >
          {page.is_favorite ? t('page.unfavorite') : t('page.favorite')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={FilePlus2} onClick={() => addChild('doc')}>
          {t('page.addSubPage')}
        </MenuItem>
        <MenuItem icon={NotebookPen} onClick={() => addChild('canvas')}>
          {t('page.addSubNotebook')}
        </MenuItem>
        <MenuItem icon={Copy} onClick={duplicate}>
          {t('page.duplicate')}
        </MenuItem>
        <MenuItem
          icon={FolderInput}
          onClick={() => {
            close();
            setMoving(true);
          }}
        >
          {t('page.moveTo')}
        </MenuItem>
        {extra && (
          <>
            <MenuSeparator />
            {typeof extra === 'function' ? extra(close) : extra}
          </>
        )}
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onClick={trash}>
          {t('page.delete')}
        </MenuItem>
      </Popover>
      {moving && <MoveDialog pageId={page.id} open={moving} onClose={() => setMoving(false)} />}
    </>
  );
}
