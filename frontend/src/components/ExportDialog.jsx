import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FileCode, FileJson, Globe, AlignLeft, Image as ImageIcon, PenTool, Loader2, Check } from 'lucide-react';
import Modal from './Modal';
import { toast } from './Toasts';
import useSettings from '../store/settingsStore';
import { usePageIndex } from '../lib/pageIndex';
import { saveBlob, safeFilename } from '../lib/saveFile';
import { API_BASE } from '../lib/apiUrl';

// "Export…" for a page: choose a format, and it is saved (a download in the
// browser, a Save-as dialog on desktop, the share sheet on Android).
//
//   kind          'doc' | 'canvas'
//   title, icon   of the page
//   getDoc()      the editor's export API (documents)
//   getNotebook() async -> { ink, settings } as drawn right now (notebooks)

const DOC_FORMATS = [
  { id: 'pdf', icon: FileText, label: 'PDF', hint: 'export.pdfDocHint' },
  { id: 'md', icon: FileCode, label: 'Markdown', hint: 'export.mdHint' },
  { id: 'html', icon: Globe, label: 'HTML', hint: 'export.htmlHint' },
  { id: 'txt', icon: AlignLeft, label: 'export.txt', hint: 'export.txtHint' },
];
const CANVAS_FORMATS = [
  { id: 'pdf', icon: FileText, label: 'PDF', hint: 'export.pdfNotebookHint' },
  { id: 'png', icon: ImageIcon, label: 'PNG', hint: 'export.pngHint' },
  { id: 'svg', icon: PenTool, label: 'SVG', hint: 'export.svgHint' },
  { id: 'excalidraw', icon: FileJson, label: 'Excalidraw', hint: 'export.excalidrawHint' },
];

function Check2({ on, onChange, children }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
    >
      <span>{children}</span>
      <span className={`flex h-5 w-5 items-center justify-center rounded ${on ? 'bg-accent text-white' : 'border border-neutral-300 dark:border-neutral-600'}`}>{on && <Check size={14} />}</span>
    </button>
  );
}

export default function ExportDialog({ open, onClose, kind, title, icon, getDoc, getNotebook }) {
  const { t, i18n } = useTranslation();
  const prefs = useSettings();
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const formats = kind === 'canvas' ? CANVAS_FORMATS : DOC_FORMATS;

  async function run(format) {
    if (busy) return;
    setBusy(format);
    setProgress(null);
    setError('');
    try {
      const base = safeFilename(title || t('page.untitled'), t('page.untitled'));
      let result;
      if (kind === 'canvas') {
        const { exportNotebook } = await import('../lib/export/notebookExport');
        const nb = await getNotebook();
        result = await exportNotebook(format, {
          ink: nb.ink,
          settings: nb.settings,
          title: base,
          options: { paper: prefs.exportPaperLines, onProgress: (done, total) => setProgress(total > 1 ? `${done} / ${total}` : null) },
        });
      } else {
        const doc = getDoc();
        if (!doc) throw new Error('editor not ready');
        const { exportDocument } = await import('../lib/export/docExport');
        result = await exportDocument(format, {
          title,
          icon,
          doc,
          byId: usePageIndex.getState().byId,
          options: { paper: prefs.exportPaper },
          untitled: t('page.untitled'),
          lang: i18n.language,
          origin: API_BASE || window.location.origin,
          fileBase: base,
        });
      }
      const filename = `${base}.${result.ext}`;
      const outcome = await saveBlob(result.blob, filename);
      if (outcome === 'cancelled') return;
      if (outcome !== 'shared') toast(outcome === 'saved' ? t('export.saved') : t('export.downloaded', { file: filename }));
      onClose();
    } catch (err) {
      console.error('Export failed', err);
      setError(t('export.failed'));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title={t('export.title')}>
      <div className="overflow-y-auto p-3">
        <div className="flex flex-col gap-1.5">
          {formats.map(({ id, icon: Icon, label, hint }) => (
            <button
              key={id}
              type="button"
              disabled={!!busy}
              onClick={() => run(id)}
              className="flex min-h-[3.5rem] items-center gap-3 rounded-xl border border-neutral-200 px-3 py-2 text-left transition hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-700/50"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent-dark dark:text-accent">
                {busy === id ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{label.startsWith('export.') ? t(label) : label}</span>
                <span className="block text-xs text-neutral-500">{busy === id && progress ? t('export.working', { progress }) : t(hint)}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-700">
          {kind === 'canvas' ? (
            <Check2 on={prefs.exportPaperLines} onChange={(v) => prefs.update({ exportPaperLines: v })}>
              {t('export.paperLines')}
            </Check2>
          ) : (
            <div className="flex items-center justify-between gap-3 px-1 text-sm">
              <span>{t('export.paperSize')}</span>
              <div className="inline-flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-900">
                {['A4', 'Letter'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => prefs.update({ exportPaper: p })}
                    className={`rounded-md px-3 py-1 transition ${prefs.exportPaper === p ? 'bg-white font-medium shadow-sm dark:bg-neutral-700' : 'text-neutral-500'}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}
