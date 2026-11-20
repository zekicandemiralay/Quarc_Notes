import { FileText, NotebookPen } from 'lucide-react';

// A page's emoji icon, or a type icon when it has none.
export default function PageIcon({ page, size = 16, className = '' }) {
  if (page?.icon) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center leading-none ${className}`}
        style={{ width: size + 2, fontSize: size }}
      >
        {page.icon}
      </span>
    );
  }
  const Icon = page?.type === 'canvas' ? NotebookPen : FileText;
  return <Icon size={size} className={`shrink-0 text-neutral-400 ${className}`} />;
}
