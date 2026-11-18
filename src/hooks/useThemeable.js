// Хук, который компоненты используют для определения режима themeable
// Возвращает { isThemeable: boolean, engineName: string | null }
//
// isThemeable = true когда DesignProvider имеет activeDesign !== null
// engineName = "themeable" (в будущем возможны другие каркасы)
//
// Семантический DOM всегда (см. Журнал § «Семантический DOM первого класса»):
// id/class/data-атрибуты — часть контракта темы, а не ветвление по isThemeable.
// Хук оставлен для будущего использования (детект custom design в компонентах),
// но НЕ для условного рендера разметки.

import { useDesign } from '../contexts/DesignProvider';

export const useThemeable = () => {
  const { activeDesign } = useDesign();
  const isThemeable = !!activeDesign;
  const engineName = isThemeable ? 'themeable' : null;
  return { isThemeable, engineName };
};

export default useThemeable;