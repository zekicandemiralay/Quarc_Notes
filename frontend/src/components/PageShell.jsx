import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu } from 'lucide-react';

// Header (with the sidebar button when the sidebar is hidden) + a
// scrolling content area, for Home / Search / Trash / Settings.
export default function PageShell({ title, actions, children, width = 'max-w-3xl' }) {
  const { t } = useTranslation();
  const { sidebarVisible, openSidebar } = useOutletContext();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {!sidebarVisible && (
          <button
            type="button"
            onClick={openSidebar}
            title={t('sidebar.expand')}
            className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Menu size={18} />
          </button>
        )}
        <div className="flex-1" />
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto w-full ${width} px-4 pb-16 sm:px-8`}>
          {title && <h1 className="mb-6 mt-2 text-2xl font-bold sm:text-3xl">{title}</h1>}
          {children}
        </div>
      </div>
    </div>
  );
}
