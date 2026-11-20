import { createReactInlineContentSpec } from '@blocknote/react';
import { usePageIndex } from '../../lib/pageIndex';

// A resolved wikilink: stores the target page's id (not its title), so
// renaming a page never breaks links pointing at it. The pill shows the
// target's *current* title (the stored one is only a fallback), and is
// struck through when the target is in the trash or gone.
function WikilinkPill({ pageId, title }) {
  const target = usePageIndex((s) => s.byId[pageId]);
  const loaded = usePageIndex((s) => s.loaded);
  const broken = loaded && (!target || target.is_deleted);
  const label = target?.title || title || 'Untitled';
  return (
    <a
      href={`/page/${pageId}`}
      onClick={(e) => {
        e.preventDefault();
        window.history.pushState({}, '', `/page/${pageId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
      className={`quarc-wikilink rounded px-1 no-underline ${
        broken
          ? 'bg-neutral-200 text-neutral-500 line-through dark:bg-neutral-700 dark:text-neutral-400'
          : 'bg-accent/15 text-accent-dark hover:bg-accent/25 dark:text-amber-300'
      }`}
      contentEditable={false}
    >
      {target?.icon ? `${target.icon} ` : ''}
      {label}
    </a>
  );
}

export const Wikilink = createReactInlineContentSpec(
  {
    type: 'wikilink',
    propSchema: {
      pageId: { default: '' },
      title: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => <WikilinkPill pageId={props.inlineContent.props.pageId} title={props.inlineContent.props.title} />,
  }
);
