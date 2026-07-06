import { useEffect, useRef } from 'react';
import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import { useCreateBlockNote, SuggestionMenuController } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/ariakit';
import '@blocknote/core/style.css';
import '@blocknote/ariakit/style.css';
import { Wikilink } from './WikilinkSpec';
import { listPages } from '../../lib/api';

const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: Wikilink,
  },
});

async function getWikilinkItems(query) {
  const pages = await listPages();
  return pages
    .filter((p) => p.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 10)
    .map((p) => ({
      title: p.title || 'Untitled',
      onItemClick: (editor) => {
        editor.insertInlineContent([
          { type: 'wikilink', props: { pageId: p.id, title: p.title || 'Untitled' } },
          ' ',
        ]);
      },
    }));
}

export default function Editor({ page, onChange }) {
  const editor = useCreateBlockNote({
    schema,
    initialContent: page.content_json?.length ? page.content_json : undefined,
  });
  const saveTimer = useRef(null);

  // Content is intentionally uncontrolled after mount (BlockNote owns its own
  // document state); we only push debounced snapshots up to the parent/API.
  useEffect(() => {
    return () => clearTimeout(saveTimer.current);
  }, []);

  function handleChange() {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onChange(editor.document);
    }, 500);
  }

  return (
    <BlockNoteView editor={editor} onChange={handleChange} theme="light">
      <SuggestionMenuController
        triggerCharacter="["
        getItems={getWikilinkItems}
      />
    </BlockNoteView>
  );
}
