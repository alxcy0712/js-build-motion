import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const GUIDE_FILES = ['motion.md', 'direction.md', 'layout-and-quality.md', 'style-and-identity.md', 'drawing.md', 'captions.md', 'workflow.md'];

export function copyGuides(skill, project) {
  const target = join(project, 'guide');
  mkdirSync(target, { recursive: true });
  for (const name of GUIDE_FILES) copyFileSync(join(skill, 'references', name), join(target, name));
}
