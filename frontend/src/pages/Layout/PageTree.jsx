import { useEffect, useState, useCallback } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { listPages, createPage } from '../../lib/api';

function buildTree(pages) {
  const byParent = new Map();
  for (const p of pages) {
    const key = p.parent_id || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(p);
  }
  return byParent;
}

function TreeNode({ page, byParent, depth, onRefresh }) {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  const children = byParent.get(page.id) || [];

  async function addChild(e) {
    e.preventDefault();
    e.stopPropagation();
    const child = await createPage({ title: 'Untitled', parent_id: page.id });
    onRefresh();
    navigate(`/page/${child.id}`);
  }

  return (
    <div>
      <div className="group flex items-center gap-1" style={{ paddingLeft: depth * 14 }}>
        {children.length > 0 ? (
          <button className="w-4 text-xs text-neutral-400" onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <NavLink
          to={`/page/${page.id}`}
          className={({ isActive }) =>
            `flex-1 truncate rounded px-2 py-1 text-sm ${isActive ? 'bg-accent/20 text-accent-dark' : 'hover:bg-neutral-200 dark:hover:bg-neutral-700'}`
          }
        >
          {page.icon ? `${page.icon} ` : page.type === 'canvas' ? '✏️ ' : '📄 '}
          {page.title || 'Untitled'}
        </NavLink>
        <button
          className="hidden pr-1 text-xs text-neutral-400 hover:text-neutral-700 group-hover:block dark:hover:text-neutral-200"
          onClick={addChild}
          title="Add sub-page"
        >
          +
        </button>
      </div>
      {open && children.map((c) => (
        <TreeNode key={c.id} page={c} byParent={byParent} depth={depth + 1} onRefresh={onRefresh} />
      ))}
    </div>
  );
}

export default function PageTree({ refreshKey }) {
  const [pages, setPages] = useState([]);

  const refresh = useCallback(() => {
    listPages().then(setPages);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const byParent = buildTree(pages);
  const roots = byParent.get(null) || [];

  return (
    <div className="flex flex-col gap-0.5">
      {roots.map((p) => (
        <TreeNode key={p.id} page={p} byParent={byParent} depth={0} onRefresh={refresh} />
      ))}
    </div>
  );
}
