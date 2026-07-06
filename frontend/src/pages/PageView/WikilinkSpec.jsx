import { createReactInlineContentSpec } from '@blocknote/react';

// A resolved wikilink: stores the target page's id (not its title), so
// renaming a page never breaks links pointing at it. Rendered as a pill;
// clicking it navigates to the target page.
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
    render: (props) => {
      const { pageId, title } = props.inlineContent.props;
      return (
        <a
          href={`/page/${pageId}`}
          onClick={(e) => {
            e.preventDefault();
            window.history.pushState({}, '', `/page/${pageId}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
          className="rounded bg-accent/20 px-1 text-accent-dark no-underline"
          contentEditable={false}
        >
          [[{title || 'Untitled'}]]
        </a>
      );
    },
  }
);
