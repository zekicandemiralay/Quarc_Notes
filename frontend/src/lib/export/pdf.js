// Loads the PDF library (pdfmake + Roboto + Roboto Mono, ~1.7 MB) the first
// time someone exports, never at startup.

let loading = null;

function load() {
  if (!loading) {
    loading = (async () => {
      const [{ default: pdfMake }, { default: vfs }, { default: mono }] = await Promise.all([
        import('pdfmake/build/pdfmake'),
        import('pdfmake/build/vfs_fonts'),
        import('./fonts/robotoMonoRegular'),
      ]);
      pdfMake.addVirtualFileSystem(vfs);
      pdfMake.addVirtualFileSystem({ 'RobotoMono-Regular.ttf': mono });
      pdfMake.addFonts({ Mono: { normal: 'RobotoMono-Regular.ttf', bold: 'RobotoMono-Regular.ttf', italics: 'RobotoMono-Regular.ttf', bolditalics: 'RobotoMono-Regular.ttf' } });
      return pdfMake;
    })().catch((err) => {
      loading = null; // allow a retry
      throw err;
    });
  }
  return loading;
}

// A pdfmake document definition -> a PDF Blob.
export async function pdfBlob(definition) {
  const pdfMake = await load();
  return pdfMake.createPdf(definition).getBlob();
}
