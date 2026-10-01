import { Toaster as Sonner, toast } from 'sonner';
import { useDir } from '../direction';

export { toast };
export function Toaster({ theme }: { theme: 'light' | 'dark' }) {
  const dir = useDir();
  return (
    <Sonner
      dir={dir}
      theme={theme}
      position={dir === 'rtl' ? 'bottom-left' : 'bottom-right'}
      toastOptions={{ classNames: { toast: '!bg-surface !text-body !border-line' } }}
    />
  );
}
