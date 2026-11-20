import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import { useCreateBlockNote, SuggestionMenuController } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/ariakit';
import '@blocknote/core/style.css';
import '@blocknote/ariakit/style.css';
import { useTranslation } from 'react-i18next';
import { Wikilink } from './WikilinkSpec';
import { createPage, uploadAttachment } from '../../lib/api';
import { apiUrl } from '../../lib/apiUrl';
import { db } from '../../lib/db';
import { on } from '../../lib/events';
import { sync } from '../../lib/sync';
import { usePageIndex } from '../../lib/pageIndex';
import useSettings from '../../store/settingsStore';

const schema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: Wikilink,
  },
});

const MAX_INLINE_IMAGE = 3 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Uploads to the server; a page created offline may not exist there yet, so
// sync once and retry. Offline, small images are embedded in the page itself.
async function uploadForPage(pageId, file) {
  try {
    return await uploadAttachment(pageId, file);
  } catch (err) {
    if (navigator.onLine) {
      await sync();
      try {
        return await uploadAttachment(pageId, file);
      } catch {
        /* fall through */
      }
    }
    if (file.type.startsWith('image/') && file.size <= MAX_INLINE_IMAGE) return readAsDataUrl(file);
    throw err;
  }
}

// Wikilinks become plain [[Title]] text for Markdown export.
function withPlainWikilinks(blocks, byId) {
  const mapInline = (node) => {
    if (Array.isArray(node)) return node.map(mapInline);
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'wikilink') {
      const title = byId[node.props?.pageId]?.title || node.props?.title || 'Untitled';
      return { type: 'text', text: `[[${title}]]`, styles: {} };
    }
    const out = { ...node };
    if (out.content !== undefined) out.content = mapInline(out.content);
    if (out.children !== undefined) out.children = mapInline(out.children);
    if (out.rows !== undefined) out.rows = mapInline(out.rows);
    if (out.cells !== undefined) out.cells = mapInline(out.cells);
    return out;
  };
  return mapInline(blocks);
}

const Editor = forwardRef(function Editor({ page, onSave }, ref) {
  const { t } = useTranslation();
  const isDark = useSettings((s) => s.isDark);
  const editor = useCreateBlockNote({
    schema,
    initialContent: page.content_json?.length ? page.content_json : undefined,
    uploadFile: (file) => uploadForPage(page.id, file),
    resolveFileUrl: async (url) => (url.startsWith('/api/') ? apiUrl(url) : url),
  });
  const saveTimer = useRef(null);
  const lastSaved = useRef(JSON.stringify(page.content_json || []));
  const base = useRef(page.server_updated_at ?? null);
  const applyingRemote = useRef(false);

  function saveNow() {
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const doc = editor.document;
    const json = JSON.stringify(doc);
    if (json === lastSaved.current) return;
    lastSaved.current = json;
    onSave(doc, { base: base.current });
  }

  useImperativeHandle(ref, () => ({
    toMarkdown: () => editor.blocksToMarkdownLossy(withPlainWikilinks(editor.document, usePageIndex.getState().byId)),
    focus: () => editor.focus(),
    flush: saveNow,
  }));

  // Never lose the last keystrokes: save when leaving the page or when the
  // app goes to the background.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', saveNow);
      if (saveTimer.current) saveNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Edited on another device while open here: load it — unless there are
  // unsaved local changes, in which case the server keeps both versions.
  useEffect(
    () =>
      on('pages-changed', async (ids) => {
        if (!ids.includes(page.id)) return;
        const row = await db.pages.get(page.id);
        if (!row || row.server_updated_at === base.current) return;
        if (row.content_json === lastSaved.current) {
          base.current = row.server_updated_at;
          return;
        }
        if (saveTimer.current) return;
        let blocks;
        try {
          blocks = JSON.parse(row.content_json);
        } catch {
          return;
        }
        applyingRemote.current = true;
        try {
          editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
        } finally {
          applyingRemote.current = false;
        }
        lastSaved.current = JSON.stringify(editor.document);
        base.current = row.server_updated_at;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page.id]
  );

  function handleChange() {
    if (applyingRemote.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, 500);
  }

  async function getWikilinkItems(query) {
    const q = query.trim().toLowerCase();
    const pages = usePageIndex.getState().pages.filter((p) => !p.is_deleted && p.id !== page.id);
    const matches = pages
      .filter((p) => (p.title || '').toLowerCase().includes(q))
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, 8)
      .map((p) => ({
        title: `${p.icon ? `${p.icon} ` : ''}${p.title || t('page.untitled')}`,
        subtext: p.type === 'canvas' ? t('page.notebook') : undefined,
        onItemClick: () => {
          editor.insertInlineContent([{ type: 'wikilink', props: { pageId: p.id, title: p.title || '' } }, ' ']);
        },
      }));
    if (query.trim()) {
      const title = query.trim();
      matches.push({
        title: t('editor.createLinkedPage', { title }),
        onItemClick: async () => {
          const created = await createPage({ title, parent_id: page.id });
          editor.insertInlineContent([{ type: 'wikilink', props: { pageId: created.id, title } }, ' ']);
        },
      });
    }
    return matches;
  }

  return (
    <BlockNoteView editor={editor} onChange={handleChange} theme={isDark ? 'dark' : 'light'} className="quarc-editor">
      <SuggestionMenuController triggerCharacter="[" getItems={getWikilinkItems} />
    </BlockNoteView>
  );
});

export default Editor;
