import { cn } from '@khalta/ui';
import labUrl from '../assets/art/lab.png';
import materialsUrl from '../assets/art/materials.png';
import plantUrl from '../assets/art/plant-hero.png';
import pourUrl from '../assets/art/pour.png';
import studioUrl from '../assets/art/studio.png';

const ART = {
  plant: { src: plantUrl, width: 199, height: 112 },
  pour: { src: pourUrl, width: 200, height: 133 },
  lab: { src: labUrl, width: 200, height: 200 },
  materials: { src: materialsUrl, width: 200, height: 133 },
  studio: { src: studioUrl, width: 200, height: 200 },
} as const;

/** Decorative imagery (generated in Canva, no baked-in text). Always alt="": the adjacent heading carries the meaning in both languages. */
export function Art({ name, className }: { name: keyof typeof ART; className?: string }) {
  const a = ART[name];
  return (
    <img
      src={a.src}
      width={a.width}
      height={a.height}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn('rounded-lg bg-white object-cover', className)}
    />
  );
}
