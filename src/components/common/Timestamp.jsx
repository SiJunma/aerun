import React from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { ru, enUS } from 'date-fns/locale';
import { useI18n } from '../../contexts/I18nProvider';

const Timestamp = ({ date, className = '' }) => {
  const { lang, t } = useI18n();
  const locale = lang === 'ru' ? ru : enUS;

  // Add text-nowrap to all instances as requested by the user
  const rootClasses = `text-nowrap ${className}`.trim();

  if (!date) return <span className={rootClasses}>—</span>;

  let formattedText = '—';

  try {
    // Handle Firebase Timestamp (has toDate method) or regular Date/string/number
    const d = date.toDate ? date.toDate() : new Date(date);
    
    // Fallback if parsing results in Invalid Date
    if (!isNaN(d.getTime())) {
      if (isToday(d)) {
        formattedText = `${t('time.today')}, ${format(d, 'HH:mm')}`;
      } else if (isYesterday(d)) {
        formattedText = `${t('time.yesterday')}, ${format(d, 'HH:mm')}`;
      } else {
        formattedText = format(d, 'd MMM yyyy, HH:mm', { locale });
      }
    }
  } catch {
    // Fallback to initial text on error
  }

  return <span className={rootClasses}>{formattedText}</span>;
};

export default Timestamp;
