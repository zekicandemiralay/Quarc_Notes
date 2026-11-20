import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus } from 'lucide-react';
import { createPage, movePage } from '../../lib/api';
import { usePageIndex, ancestorsOf } from '../../lib/pageIndex';
import PageIcon from '../../components/PageIcon';
import PageActions from '../../components/PageActions';

const COLLAPSED_KEY = 'quarc_notes_tree_collapsed';

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

const DRAG_TYPE = 'text/x-quarc-page';

function TreeRow({ page, depth, childrenByParent, collapsed, toggle, drag, onNavigate }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const kids = childrenByParent.get(page.id) || [];
  const open = !collapsed.has(page.id);
  const dropHere = drag.target?.id === page.id ? drag.target.zone : null;

  async function addChild(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!open) toggle(page.id);
    const child = await createPage({ parent_id: page.id });
    navigate(`/page/${child.id}`);
    onNavigate?.();
  }

  function zoneFor(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside';
  }

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, page.id);
          e.dataTransfer.effectAllowed = 'move';
          drag.start(page.id);
        }}
        onDragEnd={drag.end}
        onDragOver={(e) => {
          if (!drag.dragging || drag.blocked.has(page.id)) return;
          e.preventDefault();
          drag.over(page.id, zoneFor(e));
        }}
        onDrop={(e) => {
          e.preventDefault();
          drag.drop(page, zoneFor(e));
        }}
        className={`group relative flex items-center rounded-lg ${dropHere === 'inside' ? 'bg-accent/20 ring-1 ring-accent' : ''}`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {dropHere === 'before' && <div className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-accent" />}
        {dropHere === 'after' && <div className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-accent" />}
        <button
          type="button"
          onClick={() => toggle(page.id)}
          className={`flex h-6 w-5 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 ${kids.length ? '' : 'invisible'}`}
          aria-label={open ? t('sidebar.collapseItem') : t('sidebar.expandItem')}
        >
          <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        <NavLink
          to={`/page/${page.id}`}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm ${
              isActive
                ? 'bg-accent/15 font-medium text-neutral-900 dark:bg-accent/20 dark:text-white'
                : 'text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
            }`
          }
        >
          <PageIcon page={page} size={15} />
          <span className="truncate">{page.title || t('page.untitled')}</span>
        </NavLink>
        <div className="flex shrink-0 items-center opacity-100 transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
          <PageActions page={page} onTrashed={onNavigate} buttonClassName="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200" iconSize={15} />
          <button
            type="button"
            title={t('page.addSubPage')}
            onClick={addChild}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      {open &&
        kids.map((c) => (
          <TreeRow
            key={c.id}
            page={c}
            depth={depth + 1}
            childrenByParent={childrenByParent}
            collapsed={collapsed}
            toggle={toggle}
            drag={drag}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  );
}

export default function PageTree({ onNavigate }) {
  const { t } = useTranslation();
  const pages = usePageIndex((s) => s.pages);
  const byId = usePageIndex((s) => s.byId);
  const { id: activeId } = useParams();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);

  const childrenByParent = useMemo(() => {
    const map = new Map();
    for (const p of pages) {
      if (p.is_deleted) continue;
      // Orphans (parent missing locally) show at the top level.
      const parent = p.parent_id && byId[p.parent_id] && !byId[p.parent_id].is_deleted ? p.parent_id : null;
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(p);
    }
    return map;
  }, [pages, byId]);

  function persist(next) {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }

  const toggle = (id) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persist(next);
  };

  // Reveal the open page in the tree.
  useEffect(() => {
    if (!activeId) return;
    const trail = ancestorsOf(byId, activeId);
    if (trail.some((p) => collapsed.has(p.id))) {
      const next = new Set(collapsed);
      for (const p of trail) next.delete(p.id);
      persist(next);
    }
  }, [activeId, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = useMemo(() => {
    const out = new Set();
    if (!dragging) return out;
    const stack = [dragging];
    while (stack.length) {
      const cur = stack.pop();
      out.add(cur);
      for (const c of childrenByParent.get(cur) || []) stack.push(c.id);
    }
    return out;
  }, [dragging, childrenByParent]);

  const drag = {
    dragging,
    target,
    blocked,
    start: (id) => setDragging(id),
    end: () => {
      setDragging(null);
      setTarget(null);
    },
    over: (id, zone) => {
      if (target?.id !== id || target?.zone !== zone) setTarget({ id, zone });
    },
    drop: async (onto, zone) => {
      const id = dragging;
      setDragging(null);
      setTarget(null);
      if (!id || blocked.has(onto.id)) return;
      if (zone === 'inside') {
        const kids = childrenByParent.get(onto.id) || [];
        const last = kids[kids.length - 1];
        await movePage(id, onto.id, last ? (last.sort_order || 0) + 1 : 0);
        if (collapsed.has(onto.id)) toggle(onto.id);
        return;
      }
      const parent = onto.parent_id && byId[onto.parent_id] ? onto.parent_id : null;
      const sibs = (childrenByParent.get(parent) || []).filter((p) => p.id !== id);
      const i = sibs.findIndex((p) => p.id === onto.id);
      const here = sibs[i]?.sort_order || 0;
      const neighbor = zone === 'before' ? sibs[i - 1] : sibs[i + 1];
      const order = neighbor ? (here + (neighbor.sort_order || 0)) / 2 : zone === 'before' ? here - 1 : here + 1;
      await movePage(id, parent, order);
    },
  };

  const roots = childrenByParent.get(null) || [];
  if (!roots.length) return <p className="px-3 py-2 text-sm text-neutral-400">{t('sidebar.noPages')}</p>;

  return (
    <div className="flex flex-col gap-px">
      {roots.map((p) => (
        <TreeRow
          key={p.id}
          page={p}
          depth={0}
          childrenByParent={childrenByParent}
          collapsed={collapsed}
          toggle={toggle}
          drag={drag}
          onNavigate={onNavigate}
        />
      ))}
      {dragging && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            const id = dragging;
            drag.end();
            if (id) await movePage(id, null, Date.now());
          }}
          className="mt-1 rounded-lg border border-dashed border-neutral-300 px-3 py-2 text-center text-xs text-neutral-400 dark:border-neutral-600"
        >
          {t('sidebar.dropTopLevel')}
        </div>
      )}
    </div>
  );
}
